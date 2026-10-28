import 'server-only';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { goldenRatings, stabilityPasses, submissions, type Job, type JobStage, type RubricStatement } from '@/db/schema';
import { statementHash } from '@/domain/fingerprint';
import { scoreBreakdown, STABILITY_PASSES } from '@/domain/gates';
import { acceptanceCriteriaText, applyInferredScope, resolveGradeFiles } from '@/domain/fileScope';
import { analyzeDiscrimination } from '@/domain/discrimination';
import { isStatementLane, stabilityGradeBatchSize, stabilityGradesInParallel } from '@/domain/jobs';
import { seatIndexById, tagStyleForGenerate, tagStyleOf } from '@/domain/rubric';
import { guardLock, packTighten, screenDrafts, TIGHTEN_ROUNDS, tightenNeed, type LockDraft, type TightenReport, type TightenSeat, type VerifiedLock } from '@/domain/tighten';
import { gradeStatements, inventoriesForObservations } from '@/lib/engines/autorater';
import type { Seed } from '@/lib/engines/rubricFactory';
import { coreSeats, mineLocks, reviewDrafts, verifyLocks } from '@/lib/engines/tighten';
import { GeminiError } from '@/lib/ai/gemini';
import { hasReadableText, sourceFileText } from '@/lib/ai/sourceText';
import { catalogSourceFiles, listAiOutputs, prepareAiOutputs, prepareCatalogFiles } from '@/lib/services/files';
import { promptFromFields } from '@/domain/helper';
import { currentRubric, goldenState, installFactoryVersion, statementsOf, toGradeStatement } from '@/lib/services/rubric';
import { latestGroup } from '@/lib/services/stability';
import { pruneFinishedJobs, pruneGoldenRatings, pruneStabilityGroups } from '@/lib/services/retention';
import { submittedCalibration } from '@/lib/services/review';
import { getSubmission, readSource, recordEvent } from '@/lib/services/submissions';
import { ServiceError } from '@/lib/services/errors';
import { heartbeat } from './queue';

/**
 * Job bodies. Each receives a lease and must heartbeat; losing the lease
 * aborts the body (another worker has it). All model calls go through the
 * shared Gemini client, so concurrency is bounded process-wide.
 */

export class LeaseLost extends Error {
  constructor() {
    super('The job lease was lost.');
  }
}

export interface JobContext {
  job: Job;
  leaseToken: string;
  /** Renews the lease and records progress; throws LeaseLost if taken. */
  tick: (progress?: Job['progress'], checkpoint?: Record<string, unknown>) => Promise<void>;
  /** Aborted when the lease is lost or the job is cancelled. */
  signal: AbortSignal;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof LeaseLost) return false;
  if (error instanceof GeminiError) return error.kind === 'rate_limit' || error.kind === 'transport' || error.kind === 'timeout';
  if (error instanceof ServiceError) return error.status === 502;
  return false;
}

function acceptanceOf(submission: { source: unknown }): string {
  const read = readSource(submission as Parameters<typeof readSource>[0]);
  return read ? acceptanceCriteriaText(read.values) : '';
}

function taskContextOf(submission: { source: unknown; title: string }): { prompt: string; context: string; gradeContext: string; inputNames: string } {
  const read = readSource(submission as Parameters<typeof readSource>[0]);
  if (!read) return { prompt: '', context: submission.title, gradeContext: submission.title, inputNames: '' };
  const prompt = promptFromFields(read.fields);
  const context = read.fields.map((f) => `${f.label}: ${f.text}`).join('\n');
  const inputNames = read.inputFiles.map((f) => `${f.name} (id ${f.id})`).join(', ');
  const gradeContext = [`Project: ${read.projectName}`.trim(), `Task: ${submission.title}`].filter((line) => line.length > 8).join('\n');
  return { prompt, context: `${read.projectName ? `Project: ${read.projectName}\n` : ''}${context}${inputNames ? `\nInput files: ${inputNames}` : ''}`, gradeContext: gradeContext || submission.title, inputNames };
}

function scopedStatements(statements: RubricStatement[], outputs: { id: string; name: string }[], inputs: { id: string; name: string }[], roster: RubricStatement[] = statements) {
  const seats = seatIndexById(roster);
  return statements.map((s) => applyInferredScope(toGradeStatement(s, seats.get(s.id)), inputs, outputs));
}

function neededFileIds(statements: ReturnType<typeof scopedStatements>, outputs: { id: string; name: string }[], inputs: { id: string; name: string }[]) {
  const outputIds = new Set<string>();
  const inputIds = new Set<string>();
  let allOutputs = false;
  for (const statement of statements) {
    const resolved = resolveGradeFiles(statement, outputs, inputs);
    if (!resolved.ok) {
      allOutputs = true;
      continue;
    }
    if (resolved.allOutputs) allOutputs = true;
    else for (const file of resolved.outputs) outputIds.add(file.id);
    for (const file of resolved.inputs) inputIds.add(file.id);
  }
  return {
    outputIds: allOutputs || outputIds.size === 0 ? outputs.map((file) => file.id) : [...outputIds],
    inputIds: [...inputIds],
  };
}

/* ───────────────────────────────────────── rubric_generate ── */

/** Keeps a human-readable stage log in the job's progress, like the legacy "stage table". */
class StageLog {
  readonly stages: JobStage[] = [];
  seeds = { total: 0, ok: 0, thin: 0, failed: 0 };
  constructor(private readonly ctx: JobContext) {}
  begin(name: string, detail = ''): void {
    for (const s of this.stages) if (s.state === 'active') s.state = 'done';
    this.stages.push({ name, detail, at: new Date().toISOString(), state: 'active' });
  }
  note(detail: string): void {
    const active = this.stages.find((s) => s.state === 'active');
    if (active) active.detail = detail;
  }
  async tick(done: number, total: number, note: string): Promise<void> {
    await this.ctx.tick({ done, total, note, stages: this.stages, ...(this.seeds.total ? { seeds: this.seeds } : {}) });
  }
}

export async function runRubricGenerate(ctx: JobContext): Promise<Record<string, unknown>> {
  const { job } = ctx;
  const submission = await getSubmission(db(), job.submissionId);
  const payload = job.payload as { source?: string; target?: number };
  const notes = (payload.source ?? '').trim();
  const seeds: Seed[] = [];
  const { prompt, context } = taskContextOf(submission);
  const tagStyle = tagStyleForGenerate();
  const log = new StageLog(ctx);

  log.begin('Reading task inputs');
  await log.tick(0, 5, 'Reading task inputs');
  const prepared = (await prepareCatalogFiles(submission, 'inputs', 'REFERENCE_INPUT').catch(() => ({ files: [] as Awaited<ReturnType<typeof prepareCatalogFiles>>['files'] }))).files;
  const deliverables = readSource(submission)?.goldenFiles ?? [];
  log.note(`${prepared.length} input file(s)`);

  // Progress ticks are throttled: one DB write per seed outcome is fine for 100 seeds.
  const { runFactory } = await import('@/lib/engines/rubricFactory');
  const result = await runFactory({
    seeds,
    prompt,
    taskContext: context,
    notes,
    inputs: prepared,
    deliverables,
    target: payload.target,
    tagStyle,
    onStage: async (stage, detail) => {
      switch (stage) {
        case 'reading':
          log.begin('Observing task inputs', detail['observed'] === false ? 'using file text; enhancing from the brief' : `${detail['files'] ?? 0} file(s) from text, once`);
          await log.tick(0.4, 5, 'Observing task inputs');
          return;
        case 'seeding':
          log.begin(
            'Collecting expert seeds',
            detail['source'] === 'notes' ? `extracted ${detail['count']} checks from your notes` : 'model proposing every distinct check from the brief',
          );
          await log.tick(1, 5, detail['source'] === 'notes' ? `Extracted ${detail['count']} seeds from notes` : 'Proposing expert seeds');
          return;
        case 'enhancing':
          log.seeds = { total: Number(detail['seeds'] ?? 0), ok: 0, thin: 0, failed: 0 };
          log.begin('Expanding seeds into candidate checks', `${detail['seeds']} seeds · up to ${detail['perSeed']} rows each`);
          await log.tick(1, 5, `Expanding ${detail['seeds']} seeds`);
          return;
        case 'seed_done':
        case 'seed_thin':
        case 'seed_failed': {
          if (stage === 'seed_done') log.seeds.ok += 1;
          if (stage === 'seed_thin') log.seeds.thin += 1;
          if (stage === 'seed_failed') log.seeds.failed += 1;
          const finished = log.seeds.ok + log.seeds.thin + log.seeds.failed;
          const last = stage === 'seed_failed' && detail['error'] ? ` · last: ${String(detail['error']).slice(0, 100)}` : '';
          log.note(`${finished} of ${log.seeds.total} seeds done · ${log.seeds.ok} ok · ${log.seeds.thin} thin · ${log.seeds.failed} failed${last}`);
          await log.tick(1 + finished / Math.max(1, log.seeds.total), 5, `Expanding seeds (${finished}/${log.seeds.total})`);
          return;
        }
        case 'ranking':
          log.begin('Ranking the candidate bank', `${detail['bank']} rows scored for how well they separate weak work`);
          await log.tick(2.7, 5, 'Ranking candidates');
          return;
        case 'assembling':
          log.begin('Assembling the rubric', `${detail['bank']} candidates${detail['ranked'] ? ` · ${detail['ranked']} ranked` : ''} → strongest distinct claims`);
          await log.tick(3, 5, 'Assembling');
          return;
        case 'linting':
          log.begin('Checking wording (8-attribute lint)', `${detail['seated']} seated statements`);
          await log.tick(4, 5, 'Linting');
          return;
        case 'lint_chunk_failed':
          log.note(`a lint chunk failed: ${String(detail['error']).slice(0, 120)}`);
          await log.tick(4, 5, 'Linting');
          return;
      }
    },
  });

  log.begin('Saving rubric');
  await log.tick(5, 5, 'Saving rubric');
  const seatedKeys = new Set(result.statements.map((s) => s.claimKey));
  // The unseated bank is kept (compact, capped) so a weak seat can be swapped
  // for a stronger unused claim without another generation.
  const unused = result.bank.filter((row) => !seatedKeys.has(row.claimKey));
  const bank = unused
    .slice()
    .sort((a, b) => (b.strength ?? 50) - (a.strength ?? 50))
    .slice(0, 400)
    .map((row) => ({ k: row.claimKey, s: row.statement, t: row.tag, f: row.family, n: row.notes, d: row.seedId, w: row.strength }));
  const seatedStrength = Object.fromEntries(result.statements.filter((s) => typeof s.strength === 'number').map((s) => [s.claimKey, s.strength]));
  const discrimination = analyzeDiscrimination(
    result.statements.map((s) => ({ claimKey: s.claimKey, statement: s.statement, family: s.family, strength: s.strength })),
    unused.map((row) => ({ claimKey: row.claimKey, statement: row.statement, family: row.family, strength: row.strength })),
  );
  const rubric = await db().transaction(async (tx) => {
    const fresh = await getSubmission(tx, job.submissionId);
    if (fresh.stage !== 'rubric') throw new ServiceError(409, `The task moved to ${fresh.stage} while the rubric was being generated; nothing was replaced.`);
    return installFactoryVersion(tx, job.submissionId, job.createdBy, {
      seeds: seeds.map((s) => s.statement),
      statements: result.statements,
      generation: { report: result.report, bankSize: result.bank.length, bank, seeds: log.seeds, jobId: job.id, model: result.report.model, seatedStrength, discrimination },
    });
  });
  return { rubricId: rubric.id, version: rubric.version, statements: result.statements.length, report: result.report, seeds: log.seeds };
}

/* ───────────────────────────────────────── golden_autorate ── */

export async function runGoldenAutorate(ctx: JobContext): Promise<Record<string, unknown>> {
  const { job } = ctx;
  const database = db();
  const submission = await getSubmission(database, job.submissionId);
  const rubric = await currentRubric(database, job.submissionId);
  if (!rubric || rubric.id !== job.rubricId) throw new ServiceError(409, 'The rubric changed before grading started.');
  const all = await statementsOf(database, rubric.id);
  const only = (job.payload as { statementIds?: string[] }).statementIds;
  const statements = only?.length ? all.filter((s) => only.includes(s.id)) : all;
  if (statements.length === 0) return { graded: 0 };
  const { gradeContext, prompt, context } = taskContextOf(submission);
  const taskBody = prompt || context;

  const catalog = readSource(submission);
  const goldenMeta = catalog?.goldenFiles ?? [];
  if (goldenMeta.length === 0) throw new ServiceError(422, 'This task has no Golden output file in the Catalog.');
  const catalogInputs = catalog?.inputFiles ?? [];
  const grade = scopedStatements(statements, goldenMeta, catalogInputs, all);
  const needed = neededFileIds(grade, goldenMeta, catalogInputs);
  await ctx.tick({
    done: 0,
    total: statements.length,
    note: isStatementLane(job.payload)
      ? 'Reusing prepared Golden files'
      : goldenMeta.length === 1
        ? `Preparing ${goldenMeta[0]!.name}`
        : `Preparing ${goldenMeta.length} Golden files`,
  });
  const [golden, inputs] = await Promise.all([
    prepareCatalogFiles(submission, 'golden', 'CONSIDERED OUTPUT', needed.outputIds),
    needed.inputIds.length ? prepareCatalogFiles(submission, 'inputs', 'SUBMITTED INPUT', needed.inputIds) : Promise.resolve({ files: [], fingerprint: '' }),
  ]);
  const outputs = golden.files;
  const refs = inputs.files;
  if (outputs.length === 0) throw new ServiceError(422, 'This task has no Golden output file in the Catalog.');
  await ctx.tick({ done: 0, total: statements.length, note: `Grading 0 of ${statements.length} seats` });

  const basisFor = (s: (typeof statements)[number]) => ({
    statementHash: statementHash(s),
    rubricRevision: rubric.revision,
    goldenFingerprint: golden.fingerprint,
    inputsFingerprint: inputs.fingerprint,
    delivery: Object.fromEntries(outputs.map((o) => [o.id, o.delivery])),
  });

  const written = new Set<string>();
  const persist = async (partial: { answers: Record<string, boolean>; evidence: Record<string, string>; errors: Record<string, string>; model: string }) => {
    const rows = statements
      .filter((s) => !written.has(s.id) && (s.id in partial.answers || s.id in partial.errors))
      .map((s) => ({
        rubricId: rubric.id,
        statementId: s.id,
        jobId: job.id,
        source: 'ai' as const,
        verdict: s.id in partial.answers ? partial.answers[s.id]! : null,
        evidence: partial.evidence[s.id] ?? '',
        error: partial.errors[s.id] ?? null,
        model: partial.model,
        basis: basisFor(s),
      }));
    if (rows.length === 0) return;
    await database.insert(goldenRatings).values(rows);
    await pruneGoldenRatings(database, rubric.id);
    for (const row of rows) written.add(row.statementId);
    await ctx.tick({ done: written.size, total: statements.length, note: `Grading ${written.size} of ${statements.length} seats` }, { graded: [...written] });
  };

  const result = await gradeStatements({
    statements: grade,
    outputs,
    inputs: refs,
    taskContext: gradeContext,
    taskBody,
    acceptanceCriteria: acceptanceOf(submission),
    onBatch: persist,
  });
  await persist(result);

  const verdicts: Record<string, boolean | null> = {};
  for (const s of statements) verdicts[s.id] = result.answers[s.id] ?? null;
  const score = scoreBreakdown(verdicts, statements.map((s) => s.id));
  await recordEvent(database, job.submissionId, job.createdBy, 'golden_graded', { jobId: job.id, yes: score.yes, no: score.no, errors: Object.keys(result.errors).length, calls: result.usage.calls });
  return { graded: written.size, yes: score.yes, no: score.no, percent: score.percent, errors: result.errors, usage: result.usage, model: result.model, defectInventory: result.defectInventory };
}

/* ───────────────────────────────────────── stability_run ── */

export async function runStability(ctx: JobContext): Promise<Record<string, unknown>> {
  const { job } = ctx;
  const database = db();
  const submission = await getSubmission(database, job.submissionId);
  const rubric = await currentRubric(database, job.submissionId);
  if (!rubric || rubric.id !== job.rubricId) throw new ServiceError(409, 'The rubric changed before the run started.');
  const calibration = await submittedCalibration(database, rubric.id);
  const official = calibration != null;
  const statementsAt = new Date().toISOString();
  const statements = await statementsOf(database, rubric.id);
  const groupId = (job.payload as { groupId?: string }).groupId ?? crypto.randomUUID();
  const { gradeContext, prompt, context } = taskContextOf(submission);
  const taskBody = prompt || context;
  const acceptanceCriteria = acceptanceOf(submission);

  await ctx.tick({
    done: 0,
    total: STABILITY_PASSES,
    note: stabilityGradesInParallel(job.payload) ? 'Reading the AI output' : 'Staging the AI output',
  });
  const ai = await prepareAiOutputs(database, job.submissionId, 'CONSIDERED OUTPUT');
  if (ai.files.length === 0) throw new ServiceError(422, 'No AI output files are attached to this task.');
  const currentShas = (await listAiOutputs(database, job.submissionId)).map((f) => f.sha256).sort();
  const basisAi = [...((calibration?.basis as { aiOutputShas?: string[] } | undefined)?.aiOutputShas ?? [])].sort();
  // Official runs must grade exactly what the reviewer evaluated by hand.
  if (official && basisAi.length && JSON.stringify(basisAi) !== JSON.stringify(currentShas)) {
    throw new ServiceError(409, 'The AI output files changed after the human AI evaluation. The reviewer must re-evaluate before stability can run.');
  }
  const catalogInputs = readSource(submission)?.inputFiles ?? [];
  const grade = scopedStatements(statements, ai.files, catalogInputs, statements);
  const needed = neededFileIds(grade, ai.files, catalogInputs);
  const outputs = ai.files.filter((file) => needed.outputIds.includes(file.id));
  const inputs = needed.inputIds.length ? await prepareCatalogFiles(submission, 'inputs', 'SUBMITTED INPUT', needed.inputIds) : { files: [], fingerprint: '' };
  const refs = inputs.files;

  await ctx.tick({ done: 0, total: STABILITY_PASSES, note: 'Scanning for defects' });
  const inventoryByKey = await inventoriesForObservations({ statements: grade, outputs, inputs: refs, taskContext: gradeContext, taskBody, acceptanceCriteria });

  const existing = await database.select().from(stabilityPasses).where(eq(stabilityPasses.groupId, groupId));
  const donePasses = new Set(existing.map((p) => p.passIndex));
  let completed = donePasses.size;
  const liveScores: Record<string, number | null> = Object.fromEntries(existing.map((p) => [String(p.passIndex), p.scorePercent]));
  const graded: Record<number, number> = {};
  await ctx.tick({ done: completed, total: STABILITY_PASSES, note: `Running ${STABILITY_PASSES} passes`, passes: liveScores }, { groupId });

  const runPass = async (passIndex: number) => {
    if (donePasses.has(passIndex)) return;
    const result = await gradeStatements({
      statements: grade,
      outputs,
      inputs: refs,
      taskContext: gradeContext,
      taskBody,
      acceptanceCriteria,
      inventoryByKey,
      batchSize: stabilityGradeBatchSize(job.payload),
      serialBatches: !stabilityGradesInParallel(job.payload),
      onBatch: async (partial) => {
        graded[passIndex] = Object.keys(partial.answers).length + Object.keys(partial.errors).length;
        const total = Object.values(graded).reduce((a, b) => a + b, 0);
        await ctx.tick({ done: completed, total: STABILITY_PASSES, note: `Grading · ${total} of ${statements.length * STABILITY_PASSES} checks processed`, passes: liveScores }, { groupId });
      },
    });
    const answers: Record<string, boolean | null> = {};
    for (const s of statements) answers[s.id] = result.answers[s.id] ?? null;
    const score = scoreBreakdown(answers, statements.map((s) => s.id));
    await database.insert(stabilityPasses).values({
      rubricId: rubric.id,
      groupId,
      jobId: job.id,
      passIndex,
      answers,
      evidence: result.evidence,
      errors: result.errors,
      scorePercent: Object.keys(result.errors).length ? null : score.percent,
      model: result.model,
      basis: {
        rubricRevision: rubric.revision,
        statementsAt,
        calibrationId: calibration?.id ?? null,
        calibrationGateActive: official,
        aiFingerprint: ai.fingerprint,
        aiOutputShasAtCalibration: basisAi,
        inputsFingerprint: inputs.fingerprint,
        delivery: Object.fromEntries(outputs.map((o) => [o.id, o.delivery])),
        defectInventory: result.inventoryByKey,
        usage: result.usage,
      },
    });
    completed += 1;
    liveScores[String(passIndex)] = Object.keys(result.errors).length ? null : score.percent;
    await ctx.tick({ done: completed, total: STABILITY_PASSES, note: `Pass ${passIndex} done (${score.percent?.toFixed(1) ?? '—'}%)`, passes: liveScores }, { groupId });
  };

  const passIndexes = Array.from({ length: STABILITY_PASSES }, (_, i) => i + 1);
  if (stabilityGradesInParallel(job.payload)) {
    await Promise.all(passIndexes.map((index) => runPass(index)));
  } else {
    for (const index of passIndexes) await runPass(index);
  }
  const passes = await database.select().from(stabilityPasses).where(eq(stabilityPasses.groupId, groupId)).orderBy(stabilityPasses.passIndex);
  await pruneStabilityGroups(database, rubric.id);
  await recordEvent(database, job.submissionId, job.createdBy, 'stability_run', { jobId: job.id, groupId, scores: passes.map((p) => p.scorePercent) });
  await database.update(submissions).set({ updatedAt: new Date().toISOString() }).where(eq(submissions.id, job.submissionId));
  return { groupId, scores: passes.map((p) => p.scorePercent), errors: passes.map((p) => Object.keys(p.errors).length) };
}

async function runRubricHelper(ctx: JobContext): Promise<Record<string, unknown>> {
  const { report, verified } = await buildTightenReport(ctx);
  await recordEvent(db(), ctx.job.submissionId, ctx.job.createdBy, 'helper_finished', {
    jobId: ctx.job.id,
    before: report.before,
    projected: report.projected,
    reached: report.reached,
    shortBy: report.shortBy,
    swaps: report.swaps.length,
    verified,
    guarded: report.guarded.length,
    rounds: report.rounds,
  });
  return report as unknown as Record<string, unknown>;
}

/** "Get under 50%": mine grounded locks from the files, guard them, grade them for real, offer swaps. Writes nothing. */
export async function buildTightenReport(
  ctx: Pick<JobContext, 'job' | 'tick' | 'signal'>,
  /** Grades an unsaved rubric instead of the stored one. */
  given?: { statements: RubricStatement[]; golden: Record<string, boolean | null>; passes: Record<string, boolean | null>[] },
): Promise<{ report: TightenReport; verified: number }> {
  const { job } = ctx;
  const database = db();
  const submission = await getSubmission(database, job.submissionId);
  const rubric = await currentRubric(database, job.submissionId);
  if (!rubric || rubric.id !== job.rubricId) throw new ServiceError(409, 'The rubric changed before the helper started.');
  const statements = given?.statements ?? (await statementsOf(database, rubric.id));
  const [golden, passes] = given
    ? [{ verdicts: given.golden }, given.passes.map((answers) => ({ answers }))]
    : await Promise.all([goldenState(database, rubric.id, statements), latestGroup(database, rubric.id)]);
  const style = tagStyleOf({ tags: statements.map((row) => row.tag), hasCurrentRubric: true });
  const seats: TightenSeat[] = statements.map((row) => ({
    id: row.id,
    statement: row.statement,
    tag: row.tag,
    family: row.family,
    golden: golden.verdicts[row.id] ?? null,
    ai: passes.map((pass) => pass.answers[row.id] ?? null),
  }));
  const goldenFails = seats.filter((seat) => seat.golden === false).length;
  const total = TIGHTEN_ROUNDS * 2 + 1;
  const guarded: TightenReport['guarded'] = [];
  const verified: VerifiedLock[] = [];
  let result = packTighten({ seats, locks: [], style });
  let rounds = 0;
  let stoppedEarly: string | null = null;
  const done = () => result.reached && result.swaps.filter((swap) => swap.reason === 'false_on_golden').length >= goldenFails;

  if (!done()) {
    const { gradeContext, prompt, context } = taskContextOf(submission);
    const taskBody = prompt || context;
    const acceptance = acceptanceOf(submission);
    const hasInputs = (readSource(submission)?.inputFiles.length ?? 0) > 0;
    await ctx.tick({ done: 0, total, note: 'Reading the golden file, the AI output and the inputs' });
    const [goldenFiles, ai, inputs, texts] = await Promise.all([
      prepareCatalogFiles(submission, 'golden', 'CONSIDERED OUTPUT'),
      prepareAiOutputs(database, job.submissionId, 'CONSIDERED OUTPUT'),
      hasInputs ? prepareCatalogFiles(submission, 'inputs', 'TASK INPUT') : { files: [], fingerprint: '' },
      hasInputs ? catalogSourceFiles(submission, 'inputs', (file) => hasReadableText(file.name, file.mime)) : { files: [], fingerprint: '' },
    ]);
    if (ai.files.length === 0) throw new ServiceError(422, 'No AI output files are attached to this task.');
    const inputTexts = await Promise.all(texts.files.map(async (file) => `${file.name}\n${await sourceFileText(file)}`));
    const sources = [taskBody, context, acceptance, ...inputTexts].join('\n');
    const kept = statements.map((row) => ({ statement: row.statement, tag: row.tag }));
    const already: string[] = [];
    const seatRefs = statements.map((row, index) => ({ id: `s${index + 1}`, statement: row.statement }));
    const coreRefs = new Set(await coreSeats({ seats: seatRefs, taskText: sources, signal: ctx.signal }));
    seats.forEach((seat, index) => {
      seat.core = coreRefs.has(`s${index + 1}`);
    });
    result = packTighten({ seats, locks: [], style });

    while (!done() && rounds < TIGHTEN_ROUNDS) {
      rounds += 1;
      const missing = rounds === 1 ? tightenNeed(seats).flips : result.shortBy;
      const want = Math.min(10, Math.max(5, Math.ceil((missing * 1.5 + goldenFails) / 2)));
      await ctx.tick({ done: rounds * 2 - 1, total, note: `Round ${rounds}: finding what the AI output misses (${verified.length} verified so far)` });
      const mined = await Promise.allSettled(
        (['content', 'presentation'] as const).map((focus) => mineLocks({ focus, brief: taskBody, acceptance, inputs: inputs.files, golden: goldenFiles.files, ai: ai.files, kept, already, want, style, signal: ctx.signal })),
      );
      const failure = mined.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failure && mined.every((outcome) => outcome.status === 'rejected')) {
        if (rounds === 1 || !(failure.reason instanceof GeminiError)) throw failure.reason;
        stoppedEarly = `Round ${rounds} stopped: ${failure.reason.message}`;
        break;
      }
      const drafts = mined.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
      already.push(...drafts.map((draft) => draft.statement));
      const passed: (LockDraft & { id: string })[] = [];
      for (const [index, draft] of drafts.entries()) {
        const reasons = guardLock(draft, { sources, kept: [...kept.map((row) => row.statement), ...verified.map((lock) => lock.statement), ...passed.map((lock) => lock.statement)], style });
        if (reasons.length) guarded.push({ statement: draft.statement, reasons });
        else passed.push({ ...draft, id: `r${rounds}d${index + 1}` });
      }
      const existing = [...seatRefs, ...verified.map((lock) => ({ id: lock.id, statement: lock.statement }))];
      try {
        const review = await reviewDrafts({ drafts: passed, existing, taskText: sources, signal: ctx.signal });
        const screened = screenDrafts(passed, review, new Set(existing.map((row) => row.id)));
        guarded.push(...screened.dropped);
        await ctx.tick({ done: rounds * 2, total, note: `Round ${rounds}: grading ${screened.keep.length} grounded locks on the golden and the AI output` });
        verified.push(...(await verifyLocks({ drafts: screened.keep, golden: goldenFiles.files, ai: ai.files, taskContext: gradeContext, taskBody, acceptanceCriteria: acceptance })));
      } catch (error) {
        if (rounds === 1 || !(error instanceof GeminiError)) throw error;
        stoppedEarly = `Round ${rounds} stopped: ${error.message}`;
        break;
      }
      result = packTighten({ seats, locks: verified, style });
    }
  }

  return { report: { ...result, rubricRevision: rubric.revision, rounds, guarded, stoppedEarly, core: seats.filter((seat) => seat.core).map((seat) => seat.statement) }, verified: verified.length };
}

export const HANDLERS: Record<Job['kind'], (ctx: JobContext) => Promise<Record<string, unknown>>> = {
  rubric_generate: runRubricGenerate,
  golden_autorate: runGoldenAutorate,
  stability_run: runStability,
  rubric_helper: runRubricHelper,
};

export { heartbeat };
