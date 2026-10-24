import 'server-only';

import { gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissionEvents } from '@/db/schema';
import {
  countIn,
  formatHeldHours,
  holderForState,
  isStuckStatus,
  latestEntryAt,
  periodStarts,
  statusEnteredAt,
  STUCK_STATUS_HOURS,
  TEAM_ACTIVITY_ACTIONS,
  teamSignal,
  type TeamSignal,
} from '@/domain/dashboard';
import { holdAgeHours, WORK_STATE_LABEL, type WorkState } from '@/domain/workState';
import { canOversee, type Actor } from '@/lib/auth/permissions';
import { listUsers } from './admin';
import { forbidden } from './errors';
import { listSubmissions, type SubmissionListRow } from './submissions';

export interface StuckTask {
  id: string;
  catalogSubmissionId: string;
  title: string;
  heroDeliverable: string;
  workState: WorkState;
  workLabel: string;
  holderId: string | null;
  holderName: string | null;
  enteredAt: string;
  hours: number;
  held: string;
}

export interface TeamRow {
  userId: string;
  name: string;
  roles: string[];
  holding: number;
  stuck: number;
  sentWeek: number;
  approvedWeek: number;
  returnedWeek: number;
  pushedWeek: number;
  signal: TeamSignal;
}

export interface DashboardOverview {
  stuckHours: number;
  inFlight: number;
  unassigned: number;
  returned: number;
  landed: { today: number; week: number; month: number; all: number };
  pushed: { today: number; week: number; month: number; all: number };
  stuck: StuckTask[];
  team: TeamRow[];
  mine: SubmissionListRow[];
}

const TRACKED_ACTIONS = [
  ...TEAM_ACTIVITY_ACTIONS,
  'landed',
  'rubric_released',
  'rubric_claimed',
  'rubric_assigned',
  'handoff_bounced',
  'catalog_returned',
  'review_claimed',
  'review_assigned',
  'stability_reopened_rubric',
  'stability_accepted',
] as const;

/** PM / admin glance: stuck work, throughput, and who is moving or blocked. */
export async function dashboardOverview(actor: Actor, now = Date.now()): Promise<DashboardOverview> {
  if (!canOversee(actor)) throw forbidden('Only PMs, admins, and observers can open the operations dashboard.');
  const since = new Date(periodStarts(now).month - 90 * 86_400_000).toISOString();
  const [rows, people, events] = await Promise.all([
    listSubmissions(actor),
    listUsers(actor),
    db()
      .select({
        submissionId: submissionEvents.submissionId,
        actorId: submissionEvents.actorId,
        action: submissionEvents.action,
        createdAt: submissionEvents.createdAt,
      })
      .from(submissionEvents)
      .where(gte(submissionEvents.createdAt, since)),
  ]);

  const eventsByTask = new Map<string, { action: string; createdAt: string }[]>();
  for (const event of events) {
    if (!(TRACKED_ACTIONS as readonly string[]).includes(event.action)) continue;
    const list = eventsByTask.get(event.submissionId) ?? [];
    list.push({ action: event.action, createdAt: event.createdAt });
    eventsByTask.set(event.submissionId, list);
  }

  const { week } = periodStarts(now);
  const stuck: StuckTask[] = [];
  const holding = new Map<string, number>();
  const stuckByHolder = new Map<string, number>();

  for (const row of rows) {
    if (row.workState === 'submitted' || row.workState === 'other') continue;
    const enteredAt = statusEnteredAt(row, latestEntryAt(row.workState, eventsByTask.get(row.id) ?? []));
    const holder = holderForState(row);
    if (holder.id) holding.set(holder.id, (holding.get(holder.id) ?? 0) + 1);
    if (!isStuckStatus(enteredAt, now)) continue;
    const hours = holdAgeHours(enteredAt, now) ?? 0;
    stuck.push({
      id: row.id,
      catalogSubmissionId: row.catalogSubmissionId,
      title: row.title,
      heroDeliverable: row.heroDeliverable,
      workState: row.workState,
      workLabel: WORK_STATE_LABEL[row.workState],
      holderId: holder.id,
      holderName: holder.name,
      enteredAt,
      hours,
      held: formatHeldHours(hours),
    });
    if (holder.id) stuckByHolder.set(holder.id, (stuckByHolder.get(holder.id) ?? 0) + 1);
  }
  stuck.sort((a, b) => b.hours - a.hours);

  const weekMoves = (userId: string, action: string) =>
    events.filter((event) => event.actorId === userId && event.action === action && Date.parse(event.createdAt) >= week).length;

  const team = people
    .filter((person) => person.isActive)
    .map((person) => {
      const sentWeek = weekMoves(person.id, 'sent_to_review');
      const approvedWeek = weekMoves(person.id, 'review_approved');
      const returnedWeek = weekMoves(person.id, 'review_changes_requested');
      const pushedWeek = weekMoves(person.id, 'pushed_to_catalog');
      const held = holding.get(person.id) ?? 0;
      const blocked = stuckByHolder.get(person.id) ?? 0;
      return {
        userId: person.id,
        name: person.displayName ?? person.email,
        roles: person.roles,
        holding: held,
        stuck: blocked,
        sentWeek,
        approvedWeek,
        returnedWeek,
        pushedWeek,
        signal: teamSignal({ stuck: blocked, weekMoves: sentWeek + approvedWeek + returnedWeek + pushedWeek }),
      };
    })
    .filter((row) => row.roles.includes('rubric_creator') || row.roles.includes('reviewer') || row.holding > 0 || row.sentWeek + row.approvedWeek + row.returnedWeek + row.pushedWeek > 0)
    .sort((a, b) => {
      const rank = { attention: 0, moving: 1, quiet: 2 };
      return b.stuck - a.stuck || rank[a.signal] - rank[b.signal] || b.holding - a.holding || a.name.localeCompare(b.name);
    });

  return {
    stuckHours: STUCK_STATUS_HOURS,
    inFlight: rows.filter((row) => row.workState !== 'submitted').length,
    unassigned: rows.filter((row) => row.workState === 'unassigned').length,
    returned: rows.filter((row) => row.workState === 'review_returned').length,
    landed: countIn(rows.map((row) => row.landedAt), now),
    pushed: countIn(rows.map((row) => row.pushedAt ?? (row.workState === 'submitted' ? row.lastSeenAt : null)), now),
    stuck,
    team,
    mine: rows.filter((row) => row.rubricAssigneeId === actor.id || row.reviewerId === actor.id),
  };
}

export type { SubmissionListRow };
