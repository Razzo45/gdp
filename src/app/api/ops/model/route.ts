import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { modelTraffic } from '@/lib/ai/gemini';
import { route } from '@/lib/api';
import { canOversee } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/services/errors';

export const dynamic = 'force-dynamic';

/**
 * Live model traffic for admin and PM: what the adaptive controller is doing
 * right now, plus queue depth. Rubric users see their own run progress on
 * the task, not this lane.
 */
export const GET = route({}, async ({ actor }) => {
  if (!canOversee(actor)) throw forbidden('Model traffic is for admin, PM, and observers.');
  const database = db();
  const queue = await database
    .select({ status: jobs.status, kind: jobs.kind, n: count() })
    .from(jobs)
    .where(inArray(jobs.status, ['queued', 'running']))
    .groupBy(jobs.status, jobs.kind);
  const traffic = modelTraffic();
  const base = {
    target: traffic.target,
    floor: traffic.floor,
    ceiling: traffic.ceiling,
    active: traffic.active,
    activeBackground: traffic.activeBackground,
    queued: traffic.queued,
    cooldownMsRemaining: traffic.cooldownMsRemaining,
    recent429s: traffic.recent429s,
    files: { active: traffic.filesActive, queued: traffic.filesQueued },
    jobs: queue.map((q) => ({ status: q.status, kind: q.kind, count: q.n })),
  };
  const failedLastHour = (
    await database
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.status, 'failed'), sql`${jobs.finishedAt} > now() - interval '1 hour'`))
  )[0]?.n ?? 0;
  return { ...base, lanes: traffic.lanes, owners: traffic.owners, failedLastHour };
});
