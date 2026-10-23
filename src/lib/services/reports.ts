import 'server-only';

import { asc, inArray, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, submissionEvents, submissions } from '@/db/schema';
import { CATALOG_MARKED_DONE, REPORT_ACTIONS, replayTask, type ReportEvent, type ReportTask } from '@/domain/reports';
import { workStateOf } from '@/domain/workState';
import { isController, type Actor } from '@/lib/auth/permissions';
import { forbidden } from './errors';

export interface ReportData {
  tasks: ReportTask[];
  names: Map<string, string>;
}

/** Every task that entered the work lanes, replayed from its event log. PM / admin only. */
export async function loadReportData(actor: Actor, now = Date.now()): Promise<ReportData> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can open reports.');
  const database = db();
  const [rows, people] = await Promise.all([
    database
      .select({
        id: submissions.id,
        catalogSubmissionId: submissions.catalogSubmissionId,
        title: submissions.title,
        landedAt: submissions.landedAt,
        stage: submissions.stage,
        rubricAssigneeId: submissions.rubricAssigneeId,
        reviewStatus: submissions.reviewStatus,
        handoffStatus: submissions.handoffStatus,
        pushedAt: submissions.pushedAt,
        upstreamChangedAt: submissions.upstreamChangedAt,
      })
      .from(submissions)
      .where(ne(submissions.stage, 'parked')),
    database.select({ id: profiles.id, email: profiles.email, displayName: profiles.displayName }).from(profiles),
  ]);
  const events =
    rows.length === 0
      ? []
      : await database
          .select({ submissionId: submissionEvents.submissionId, action: submissionEvents.action, actorId: submissionEvents.actorId, detail: submissionEvents.detail, createdAt: submissionEvents.createdAt })
          .from(submissionEvents)
          .where(inArray(submissionEvents.action, REPORT_ACTIONS))
          .orderBy(asc(submissionEvents.id));
  const byTask = new Map<string, ReportEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.submissionId) ?? [];
    list.push(event);
    byTask.set(event.submissionId, list);
  }
  return {
    tasks: rows.map((row) => {
      const workState = workStateOf(row);
      const logged = byTask.get(row.id) ?? [];
      let timeline = replayTask({ landedAt: row.landedAt, events: logged, now });
      if (workState === 'submitted' && timeline.segments.at(-1)?.state !== 'submitted') {
        const last = logged.reduce((latest, event) => (Date.parse(event.createdAt) > latest ? Date.parse(event.createdAt) : latest), Date.parse(row.landedAt));
        const markedAt = Math.max(last, Date.parse(row.pushedAt ?? row.upstreamChangedAt ?? row.landedAt));
        timeline = replayTask({ landedAt: row.landedAt, events: [...logged, { action: CATALOG_MARKED_DONE, actorId: null, detail: {}, createdAt: new Date(markedAt).toISOString() }], now });
      }
      return { id: row.id, catalogSubmissionId: row.catalogSubmissionId, title: row.title, landedAt: row.landedAt, workState, timeline };
    }),
    names: new Map(people.map((p) => [p.id, p.displayName ?? p.email])),
  };
}
