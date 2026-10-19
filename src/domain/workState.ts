import type { HandoffStatus, ReviewStatus, Stage } from '@/db/schema';

/**
 * PM list tabs. These are presentation of our internal stage + seats, not
 * Catalog statuses and not an authorization boundary.
 */
export const WORK_STATES = ['unassigned', 'preparing', 'in_review', 'review_returned', 'stability', 'platform_returned', 'handoff', 'submitted', 'other'] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** Filter bar on the live board. Other stays visible so a bad catchup cannot hide work. */
export const BOARD_STATES = ['unassigned', 'preparing', 'in_review', 'review_returned', 'stability', 'handoff', 'platform_returned', 'submitted', 'other'] as const;

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  unassigned: 'Unassigned',
  preparing: 'Preparing',
  in_review: 'In review',
  review_returned: 'Review returned',
  stability: 'Approved',
  platform_returned: 'Platform returned',
  handoff: 'Ready to submit',
  submitted: 'Submitted',
  other: 'Other',
};

export const WORK_STATE_HINT: Record<WorkState, string> = {
  unassigned: 'Assign a Rubric Team or a specific person.',
  preparing: 'Complete Golden, run Stability to see repeatability, then send it to Review.',
  in_review: 'Calibrate the AI score, then approve or request changes.',
  review_returned: 'Open the reviewer note, fix the rubric, re-run Stability if you want, then send it back.',
  stability: 'Run 3 Stability checks, then submit.',
  platform_returned: 'The Catalog bounced the handoff. Fix what they flagged and submit again.',
  handoff: 'Confirm the gates, then submit to the Data Program.',
  submitted: 'No action needed unless returned.',
  other: 'On a watched project, but not in the GDP work or handoff status.',
};

/** A seat held this long without a handoff is stale for the PM board. */
export const STALE_HOLD_HOURS = 48;

export function holdAgeHours(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (now - at) / 3_600_000);
}

/** Last time Catalog/platform status moved, as we saw it. Landed if it has not moved since. */
export function platformStateChangedAt(row: { upstreamChangedAt: string | null; landedAt: string }): string {
  return row.upstreamChangedAt ?? row.landedAt;
}

export function isStaleHold(iso: string | null | undefined, now = Date.now()): boolean {
  const hours = holdAgeHours(iso, now);
  return hours !== null && hours >= STALE_HOLD_HOURS;
}

/** Delivered seats are done — age does not make them stale on the PM hold board. */
export function seatIsStale(row: { claimedAt: string | null | undefined; stage: string }, now = Date.now()): boolean {
  if (row.stage === 'done') return false;
  return isStaleHold(row.claimedAt, now);
}

/** Board rows for the PM list. A search looks across every panel. */
export function boardListRows<T extends { workState: WorkState }>(
  rows: T[],
  filter: { workState?: WorkState; q?: string },
): T[] {
  if (filter.q?.trim()) return rows;
  if (filter.workState) return rows.filter((row) => row.workState === filter.workState);
  return rows;
}

export function workStateOf(row: {
  stage: Stage;
  rubricAssigneeId: string | null;
  reviewStatus: ReviewStatus | null;
  handoffStatus?: HandoffStatus | null;
}): WorkState {
  if (row.stage === 'parked') return 'other';
  if (row.stage === 'done') return 'submitted';
  if (row.handoffStatus === 'bounced') return 'platform_returned';
  if (row.stage === 'handoff') return 'handoff';
  if (row.stage === 'stability') return 'stability';
  if (row.stage === 'review') return 'in_review';
  if (row.stage === 'rubric' && row.reviewStatus === 'changes_requested') return 'review_returned';
  if (row.stage === 'rubric' && !row.rubricAssigneeId) return 'unassigned';
  if (row.stage === 'rubric') return 'preparing';
  return 'preparing';
}

/** Catalog bounce is leftover state. Continuing work must drop it. */
export function handoffAfterContinue(status: HandoffStatus | null | undefined): HandoffStatus | null {
  return status === 'bounced' ? null : (status ?? null);
}

/** After review approve: reuse an accepted passing Stability and skip that stage. */
export function reviewAdvanceAfterApprove(input: {
  handoffStatus: HandoffStatus | null | undefined;
  stabilityAccepted: boolean;
  stabilityOk: boolean;
}): { stage: 'stability' | 'handoff'; handoffStatus: HandoffStatus | null } {
  if (input.stabilityAccepted && input.stabilityOk) {
    return { stage: 'handoff', handoffStatus: 'stability_pass' };
  }
  return { stage: 'stability', handoffStatus: handoffAfterContinue(input.handoffStatus) };
}
