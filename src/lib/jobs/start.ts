import 'server-only';

import { db } from '@/db/client';
import type { Job } from '@/db/schema';
import { MAX_ROUGH_CHARS, MAX_SEED_CHARS, MAX_SEEDS, RUBRIC_MIN, RUBRIC_TARGET } from '@/domain/rubric';
import { canRunStability, holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import { assertGeminiConfigured } from '@/lib/ai/gemini';
import { conflict, forbidden, invalid, ServiceError } from '@/lib/services/errors';
import { listAiOutputs } from '@/lib/services/files';
import { submittedCalibration } from '@/lib/services/review';
import { currentRubric, ensureCurrentRubric, statementsOf } from '@/lib/services/rubric';
import { getSubmission, recordEvent } from '@/lib/services/submissions';
import { enqueue, JobConflict } from './queue';

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

export async function startRubricGeneration(actor: Actor, submissionId: string, input: { seeds?: string[]; source?: string; seedMode?: 'rough' | 'expert'; target?: number; requestId: string }): Promise<Job> {
  requireGemini();
  const givenSeeds = (input.seeds ?? []).map((s) => s.trim()).filter(Boolean);
  const looksLikeNotes = !input.seedMode && givenSeeds.some((s) => s.length > MAX_SEED_CHARS);
  const source = (input.source ?? '').trim() || (looksLikeNotes ? givenSeeds.join('\n\n') : '');
  const seedMode = input.seedMode ?? (source ? 'rough' : givenSeeds.length ? 'expert' : 'rough');
  const seeds = seedMode === 'rough' ? [] : givenSeeds;
  if (seedMode === 'rough' && source.length > MAX_ROUGH_CHARS) throw invalid(`Keep rough notes under ${MAX_ROUGH_CHARS} characters.`);
  if (seeds.some((s) => s.length > MAX_SEED_CHARS)) throw invalid(`Keep each expert seed under ${MAX_SEED_CHARS} characters.`);
  if (seeds.length > MAX_SEEDS) throw invalid(`At most ${MAX_SEEDS} expert seeds.`);
  const target = input.target ?? RUBRIC_TARGET;
  if (target < RUBRIC_MIN || target > 60) throw invalid(`Target must be between ${RUBRIC_MIN} and 60 statements.`);
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task. Claim or ask a PM to assign it.');
      if (submission.stage !== 'rubric') throw conflict(`The rubric is locked while the task is in ${submission.stage}.`);
      const rubric = await ensureCurrentRubric(tx, submissionId, actor.id);
      const job = await enqueue(tx, { kind: 'rubric_generate', submissionId, rubricId: rubric.id, requestId: input.requestId, payload: { seedMode, source, seeds, target }, createdBy: actor.id, deadlineMs: 45 * 60_000 });
      await recordEvent(tx, submissionId, actor.id, 'rubric_generation_started', { jobId: job.id, seedMode, seeds: seeds.length, sourceChars: source.length, target });
      return job;
    }),
  );
}

export async function startGoldenAutorate(actor: Actor, submissionId: string, input: { statementIds?: string[]; requestId: string }): Promise<Job> {
  requireGemini();
  return wrap(() =>
    db().transaction(async (tx) => {
      const submission = await getSubmission(tx, submissionId);
      if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
      const rubric = await currentRubric(tx, submissionId);
      if (!rubric) throw conflict('Write or generate a rubric first.');
      const statements = await statementsOf(tx, rubric.id);
      if (statements.length === 0) throw conflict('The rubric has no statements.');
      const ids = input.statementIds?.filter((id) => statements.some((s) => s.id === id));
      const job = await enqueue(tx, { kind: 'golden_autorate', submissionId, rubricId: rubric.id, requestId: input.requestId, payload: ids?.length ? { statementIds: ids } : {}, createdBy: actor.id, deadlineMs: 60 * 60_000 });
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
      if ((await listAiOutputs(tx, submissionId)).length === 0) throw conflict('No AI output files are attached.');
      const official = Boolean(await submittedCalibration(tx, rubric.id));
      const job = await enqueue(tx, {
        kind: 'stability_run',
        submissionId,
        rubricId: rubric.id,
        requestId: input.requestId,
        payload: { groupId: crypto.randomUUID(), calibrationGateActive: official },
        createdBy: actor.id,
        deadlineMs: 2 * 60 * 60_000,
      });
      await recordEvent(tx, submissionId, actor.id, 'stability_started', { jobId: job.id, groupId: (job.payload as { groupId: string }).groupId, calibrationGateActive: official });
      return job;
    }),
  );
}
