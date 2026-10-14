import 'server-only';

import { db } from '@/db/client';
import type { Job } from '@/db/schema';
import { isHeavyMedia } from '@/domain/jobs';
import { countFamilies, MAX_ROUGH_CHARS, quotaSpread, RUBRIC_MIN, RUBRIC_TARGET } from '@/domain/rubric';
import { canRunStability, holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import { assertGeminiConfigured } from '@/lib/ai/gemini';
import { conflict, forbidden, invalid, ServiceError } from '@/lib/services/errors';
import { listAiOutputs } from '@/lib/services/files';
import { submittedCalibration } from '@/lib/services/review';
import { helperGate, promptFromFields } from '@/domain/helper';
import { currentRubric, ensureCurrentRubric, goldenState, statementsOf } from '@/lib/services/rubric';
import { latestGroup, stabilityView } from '@/lib/services/stability';
import { getSubmission, readSource, recordEvent } from '@/lib/services/submissions';
import { enqueue, JobConflict } from './queue';

function heavyFlag(files: { mime?: string; name?: string; size?: number }[]): { heavy?: true } {
  return files.some((file) => isHeavyMedia(file)) ? { heavy: true } : {};
}

/** User-facing entry points that put work on the queue, with the seat checks. */

function requireGemini(): void {
  try {
    assertGeminiConfigured();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The grading model is not configured on this server (GEMINI_API_KEY).';
    throw new ServiceError(503, message);
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof JobConflict) throw conflict(error.message, { jobId: error.existing.id });
    throw error;
  }
}

export async function startRubricGeneration(actor: Actor, submissionId: string, input: { source?: string; target?: number; requestId: string }): Promise<Job> {
  requireGemini();
  const source = (input.source ?? '').trim();
  if (source.length > MAX_ROUGH_CHARS) throw invalid(`Keep rough notes under ${MAX_ROUGH_CHARS} characters.`);
  const target = input.target ?? RUBRIC_TARGET;
  if (target < RUBRIC_MIN || target > 60) throw invalid(`Target must be between ${RUBRIC_MIN} and 60 statements.`);
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task. Claim or ask a PM to assign it.');
      if (submission.stage !== 'rubric') throw conflict(`The rubric is locked while the task is in ${submission.stage}.`);
      const rubric = await ensureCurrentRubric(tx, submissionId, actor.id);
      const sourceFiles = readSource(submission);
      const job = await enqueue(tx, {
        kind: 'rubric_generate',
        submissionId,
        rubricId: rubric.id,
        requestId: input.requestId,
        payload: { source, target, ...heavyFlag([...(sourceFiles?.inputFiles ?? []), ...(sourceFiles?.goldenFiles ?? [])]) },
        createdBy: actor.id,
        deadlineMs: 45 * 60_000,
      });
      await recordEvent(tx, submissionId, actor.id, 'rubric_generation_started', { jobId: job.id, sourceChars: source.length, target });
      return job;
    }),
  );
}

export async function startGoldenAutorate(actor: Actor, submissionId: string, input: { statementIds?: string[]; requestId: string }): Promise<Job> {
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
      const rubric = await currentRubric(tx, submissionId);
      if (!rubric) throw conflict('Write or generate a rubric first.');
      const statements = await statementsOf(tx, rubric.id);
      if (statements.length === 0) throw conflict('The rubric has no statements.');
      const spread = quotaSpread(countFamilies(statements));
      if (!spread.ready) throw conflict(`Seat the rubric at 5 Format, 15 Content, 30 Visual first. ${spread.warning}`);
      requireGemini();
      const ids = input.statementIds?.filter((id) => statements.some((s) => s.id === id));
      const files = readSource(submission);
      const job = await enqueue(tx, {
        kind: 'golden_autorate',
        submissionId,
        rubricId: rubric.id,
        requestId: input.requestId,
        payload: { ...(ids?.length ? { statementIds: ids } : {}), ...heavyFlag([...(files?.goldenFiles ?? []), ...(files?.inputFiles ?? [])]) },
        createdBy: actor.id,
        deadlineMs: 60 * 60_000,
      });
      await recordEvent(tx, submissionId, actor.id, 'golden_autorate_started', { jobId: job.id, statements: ids?.length ?? statements.length });
      return job;
    }),
  );
}

export async function startStabilityRun(actor: Actor, submissionId: string, input: { requestId: string }): Promise<Job> {
  requireGemini();
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!canRunStability(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
      const rubric = await currentRubric(tx, submissionId);
      if (!rubric) throw conflict('There is no rubric.');
      const outputs = await listAiOutputs(tx, submissionId);
      if (outputs.length === 0) throw conflict('No AI output files are attached.');
      const current = await stabilityView(tx, rubric.id);
      if (current.accepted) throw conflict('This Stability result is accepted. Running it again would replace the handoff scores.');
      const official = Boolean(await submittedCalibration(tx, rubric.id));
      const inputs = readSource(submission)?.inputFiles ?? [];
      const job = await enqueue(tx, {
        kind: 'stability_run',
        submissionId,
        rubricId: rubric.id,
        requestId: input.requestId,
        payload: { groupId: crypto.randomUUID(), calibrationGateActive: official, ...heavyFlag([...outputs, ...inputs]) },
        createdBy: actor.id,
        deadlineMs: 2 * 60 * 60_000,
      });
      await recordEvent(tx, submissionId, actor.id, 'stability_started', { jobId: job.id, groupId: (job.payload as { groupId: string }).groupId, calibrationGateActive: official });
      return job;
    }),
  );
}

export async function startHelper(actor: Actor, submissionId: string, input: { requestId: string }): Promise<Job> {
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task. Claim or ask a PM to assign it.');
      if (submission.stage !== 'rubric') throw conflict(`The helper is available while the task is in rubric, not ${submission.stage}.`);
      const rubric = await currentRubric(tx, submissionId);
      const statements = rubric ? await statementsOf(tx, rubric.id) : [];
      const golden = rubric ? await goldenState(tx, rubric.id, statements) : null;
      const passes = rubric ? await latestGroup(tx, rubric.id) : [];
      const outputs = await listAiOutputs(tx, submissionId);
      const source = readSource(submission);
      const prompt = promptFromFields(source?.fields ?? []);
      const gate = helperGate({
        hasRubric: statements.length > 0,
        goldenGraded: statements.filter((row) => golden?.verdicts[row.id] === true || golden?.verdicts[row.id] === false).length,
        stabilityPasses: passes.length,
        hasAi: outputs.length > 0,
        hasPrompt: prompt.trim().length > 0,
      });
      if (!gate.ok) throw conflict(gate.missing.join(' '));
      requireGemini();
      const files = [...(source?.goldenFiles ?? []), ...(source?.inputFiles ?? []), ...outputs];
      const job = await enqueue(tx, {
        kind: 'rubric_helper',
        submissionId,
        rubricId: rubric!.id,
        requestId: input.requestId,
        payload: { ...heavyFlag(files) },
        createdBy: actor.id,
        deadlineMs: 30 * 60_000,
      });
      await recordEvent(tx, submissionId, actor.id, 'helper_started', { jobId: job.id });
      return job;
    }),
  );
}
