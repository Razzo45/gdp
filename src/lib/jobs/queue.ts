import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs, type Job, type JobKind } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { conflictingJob } from '@/domain/jobs';
import { pruneFinishedJobs } from '@/lib/services/retention';
export { conflictingJob };

/**
 * One job table for everything long-running. Replaces the legacy five
 * queue systems. Claims use `FOR UPDATE SKIP LOCKED`; a worker holds a
 * lease it must renew; expired leases are reclaimed by the next poll.
 */

export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
const DEFAULT_DEADLINE_MS = 2 * 60 * 60_000;

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

export class JobConflict extends Error {
  constructor(public readonly existing: Job) {
    super(`A ${existing.kind} job is already ${existing.status} for this submission.`);
  }
}

export async function enqueue(
  database: DbOrTx,
  input: {
    kind: JobKind;
    submissionId: string;
    rubricId: string | null;
    requestId: string;
    payload: Record<string, unknown>;
    createdBy: string | null;
    deadlineMs?: number;
    maxAttempts?: number;
  },
): Promise<Job> {
  // Idempotent on request id: a retried click returns the same job.
  const existingByRequest = (await database.select().from(jobs).where(eq(jobs.requestId, input.requestId)).limit(1))[0];
  if (existingByRequest) return existingByRequest;

  const actives = await database
    .select()
    .from(jobs)
    .where(and(eq(jobs.submissionId, input.submissionId), eq(jobs.kind, input.kind), inArray(jobs.status, ['queued', 'running'])));
  const blocking = conflictingJob(input.kind, input.payload, actives);
  if (blocking) throw new JobConflict(blocking);

  const [created] = await database
    .insert(jobs)
    .values({
      kind: input.kind,
      submissionId: input.submissionId,
      rubricId: input.rubricId,
      requestId: input.requestId,
      payload: input.payload,
      createdBy: input.createdBy,
      deadlineAt: iso(input.deadlineMs ?? DEFAULT_DEADLINE_MS),
      maxAttempts: input.maxAttempts ?? 3,
    })
    .returning();
  return created!;
}

/** Claims one runnable job (queued, or running with an expired lease). */
export async function claimNext(kinds: readonly JobKind[]): Promise<{ job: Job; leaseToken: string } | null> {
  return db().transaction(async (tx) => {
    const now = new Date().toISOString();
    const candidate = (
      await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            inArray(jobs.kind, [...kinds]),
            or(eq(jobs.status, 'queued'), and(eq(jobs.status, 'running'), or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, now)))),
            lt(jobs.attempts, jobs.maxAttempts),
          ),
        )
        .orderBy(
          sql`case
            when ${jobs.kind} = 'golden_autorate'
              and jsonb_typeof(${jobs.payload}->'statementIds') = 'array'
              and jsonb_array_length(${jobs.payload}->'statementIds') between 1 and 8
            then 0
            when ${jobs.kind} = 'rubric_generate' then 2
            else 1
          end`,
          jobs.createdAt,
        )
        .limit(1)
        .for('update', { skipLocked: true })
    )[0];
    if (!candidate) return null;
    const leaseToken = crypto.randomUUID();
    const [job] = await tx
      .update(jobs)
      .set({
        status: 'running',
        leaseToken,
        leaseUntil: iso(LEASE_MS),
        heartbeatAt: now,
        startedAt: sql`coalesce(${jobs.startedAt}, now())`,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(eq(jobs.id, candidate.id))
      .returning();
    return job ? { job, leaseToken } : null;
  });
}

/** Renews the lease; returns false when the lease was lost (another worker took over or the job was cancelled). */
export async function heartbeat(jobId: string, leaseToken: string, patch: { progress?: Job['progress']; checkpoint?: Record<string, unknown> } = {}): Promise<boolean> {
  const updated = await db()
    .update(jobs)
    .set({
      leaseUntil: iso(LEASE_MS),
      heartbeatAt: new Date().toISOString(),
      ...(patch.progress ? { progress: patch.progress } : {}),
      ...(patch.checkpoint ? { checkpoint: patch.checkpoint } : {}),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken), eq(jobs.status, 'running')))
    .returning({ id: jobs.id });
  return updated.length === 1;
}

export async function complete(jobId: string, leaseToken: string, result: Record<string, unknown>): Promise<boolean> {
  const updated = await db()
    .update(jobs)
    .set({ status: 'succeeded', result, finishedAt: new Date().toISOString(), leaseToken: null, leaseUntil: null, progress: { done: 1, total: 1, note: 'done' } })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken), eq(jobs.status, 'running')))
    .returning({ id: jobs.id, submissionId: jobs.submissionId, kind: jobs.kind });
  const done = updated[0];
  if (done) await pruneFinishedJobs(db(), done.submissionId, done.kind);
  return updated.length === 1;
}

/** Marks a failure. Retryable failures go back to the queue while attempts remain. */
export async function fail(jobId: string, leaseToken: string, error: string, retryable: boolean): Promise<void> {
  const job = (await db().select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken))).limit(1))[0];
  if (!job) return;
  const canRetry = retryable && job.attempts < job.maxAttempts && new Date(job.deadlineAt).getTime() > Date.now();
  await db()
    .update(jobs)
    .set(
      canRetry
        ? { status: 'queued', error, leaseToken: null, leaseUntil: null }
        : { status: 'failed', error, finishedAt: new Date().toISOString(), leaseToken: null, leaseUntil: null },
    )
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken)));
  if (!canRetry) await pruneFinishedJobs(db(), job.submissionId, job.kind);
}

export async function cancel(database: DbOrTx, jobId: string, actorId: string | null): Promise<Job | null> {
  const [job] = await database
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: new Date().toISOString(), leaseToken: null, leaseUntil: null, error: actorId ? 'Cancelled by user.' : 'Cancelled.' })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])))
    .returning();
  return job ?? null;
}

export async function jobsForSubmission(database: DbOrTx, submissionId: string, limit = 20): Promise<Job[]> {
  return database.select().from(jobs).where(eq(jobs.submissionId, submissionId)).orderBy(sql`${jobs.createdAt} desc`).limit(limit);
}

export async function activeJob(database: DbOrTx, submissionId: string, kind: JobKind): Promise<Job | null> {
  return (
    (await database
      .select()
      .from(jobs)
      .where(and(eq(jobs.submissionId, submissionId), eq(jobs.kind, kind), inArray(jobs.status, ['queued', 'running'])))
      .limit(1))[0] ?? null
  );
}

/** Housekeeping: jobs past their deadline are failed so they stop being claimed. */
export async function expireOverdue(): Promise<number> {
  const updated = await db()
    .update(jobs)
    .set({ status: 'failed', error: 'The job passed its deadline.', finishedAt: new Date().toISOString(), leaseToken: null, leaseUntil: null })
    .where(and(inArray(jobs.status, ['queued', 'running']), lt(jobs.deadlineAt, new Date().toISOString())))
    .returning({ id: jobs.id });
  return updated.length;
}
