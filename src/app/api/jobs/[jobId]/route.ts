import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { route } from '@/lib/api';
import { holdsRubricSeat } from '@/lib/auth/permissions';
import { cancel } from '@/lib/jobs/queue';
import { forbidden, notFound } from '@/lib/services/errors';
import { getVisibleSubmission, recordEvent } from '@/lib/services/submissions';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor, params }) => {
  const database = db();
  const job = (await database.select().from(jobs).where(eq(jobs.id, params['jobId']!)).limit(1))[0];
  if (!job) throw notFound('The job');
  await getVisibleSubmission(database, actor, job.submissionId);
  return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, error: job.error, result: job.result, attempts: job.attempts, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt };
});

export const DELETE = route({}, async ({ actor, params }) => {
  const database = db();
  const job = (await database.select().from(jobs).where(eq(jobs.id, params['jobId']!)).limit(1))[0];
  if (!job) throw notFound('The job');
  const submission = await getVisibleSubmission(database, actor, job.submissionId);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  const cancelled = await cancel(database, job.id, actor.id);
  if (cancelled) await recordEvent(database, job.submissionId, actor.id, 'job_cancelled', { jobId: job.id, kind: job.kind });
  return { ok: true, cancelled: cancelled !== null };
});
