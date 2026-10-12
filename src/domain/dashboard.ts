import { holdAgeHours } from '@/domain/workState';
import type { WorkState } from '@/domain/workState';

/** A task sitting in the same work state this long needs a PM look. */
export const STUCK_STATUS_HOURS = 24;

export const STATE_ENTRY_ACTIONS: Record<WorkState, readonly string[]> = {
  unassigned: ['landed', 'rubric_released'],
  preparing: ['rubric_claimed', 'rubric_assigned', 'handoff_bounced'],
  in_review: ['sent_to_review', 'review_claimed', 'review_assigned'],
  review_returned: ['review_changes_requested', 'stability_reopened_rubric'],
  stability: ['review_approved'],
  platform_returned: ['handoff_bounced', 'catalog_returned'],
  handoff: ['stability_accepted'],
  submitted: ['pushed_to_catalog'],
  other: ['parked'],
};

export const TEAM_ACTIVITY_ACTIONS = ['sent_to_review', 'review_approved', 'review_changes_requested', 'pushed_to_catalog'] as const;

export type TeamSignal = 'attention' | 'moving' | 'quiet';

export function periodStarts(now = Date.now()): { day: number; week: number; month: number } {
  const date = new Date(now);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (date.getUTCDay() + 6) % 7;
  return {
    day,
    week: day - weekday * 86_400_000,
    month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  };
}

export function countIn(stamps: readonly (string | null | undefined)[], now = Date.now()): { today: number; week: number; month: number; all: number } {
  const { day, week, month } = periodStarts(now);
  let today = 0;
  let thisWeek = 0;
  let thisMonth = 0;
  let all = 0;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const time = Date.parse(stamp);
    if (!Number.isFinite(time)) continue;
    all += 1;
    if (time >= month) thisMonth += 1;
    if (time >= week) thisWeek += 1;
    if (time >= day) today += 1;
  }
  return { today, week: thisWeek, month: thisMonth, all };
}

export function statusEnteredAt(
  row: {
    workState: WorkState;
    landedAt: string;
    rubricClaimedAt: string | null;
    reviewClaimedAt: string | null;
    lastClaimedAt: string | null;
    updatedAt: string;
    pushedAt: string | null;
  },
  entryEventAt: string | null,
): string {
  if (entryEventAt) return entryEventAt;
  if (row.workState === 'unassigned') return row.landedAt;
  if (row.workState === 'preparing') return row.rubricClaimedAt ?? row.landedAt;
  if (row.workState === 'in_review') return row.reviewClaimedAt ?? row.lastClaimedAt ?? row.landedAt;
  if (row.workState === 'submitted' || row.workState === 'other') return row.pushedAt ?? row.updatedAt;
  return row.lastClaimedAt ?? row.updatedAt ?? row.landedAt;
}

export function isStuckStatus(enteredAt: string, now = Date.now(), hours = STUCK_STATUS_HOURS): boolean {
  const age = holdAgeHours(enteredAt, now);
  return age !== null && age >= hours;
}

export function holderForState(row: {
  workState: WorkState;
  rubricAssigneeId: string | null;
  rubricAssigneeName: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
}): { id: string | null; name: string | null } {
  if (row.workState === 'submitted' || row.workState === 'unassigned' || row.workState === 'other') return { id: null, name: null };
  if (row.workState === 'in_review') return { id: row.reviewerId, name: row.reviewerName };
  return { id: row.rubricAssigneeId, name: row.rubricAssigneeName };
}

export function teamSignal(input: { stuck: number; weekMoves: number }): TeamSignal {
  if (input.stuck > 0) return 'attention';
  if (input.weekMoves > 0) return 'moving';
  return 'quiet';
}

export function formatHeldHours(hours: number): string {
  if (hours < 48) return `${Math.max(1, Math.round(hours))} h`;
  return `${Math.round(hours / 24)} d`;
}

export function latestEntryAt(workState: WorkState, events: readonly { action: string; createdAt: string }[]): string | null {
  const allowed = new Set(STATE_ENTRY_ACTIONS[workState]);
  let latest: string | null = null;
  for (const event of events) {
    if (!allowed.has(event.action)) continue;
    if (!latest || event.createdAt > latest) latest = event.createdAt;
  }
  return latest;
}
