import type { ReviewStatus, Stage } from '@/db/schema';

/**
 * PM list tabs. These are presentation of our internal stage + seats, not
 * Catalog statuses and not an authorization boundary.
 */
export const WORK_STATES = ['unassigned', 'preparing', 'in_review', 'review_returned', 'stability', 'handoff', 'submitted'] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  unassigned: 'Unassigned',
  preparing: 'Preparing',
  in_review: 'In review',
  review_returned: 'Review returned',
  stability: 'Approved',
  handoff: 'Ready to submit',
  submitted: 'Submitted',
};

export const WORK_STATE_HINT: Record<WorkState, string> = {
  unassigned: 'Assign a Rubric Team or a specific person.',
  preparing: 'Complete Golden, run Stability to see repeatability, then send it to Review.',
  in_review: 'Calibrate the AI score, then approve or request changes.',
  review_returned: 'Open the reviewer note, fix the rubric, re-run Stability if you want, then send it back.',
  stability: 'Run 3 Stability checks, then submit.',
  handoff: 'Confirm the gates, then submit to the Data Program.',
  submitted: 'No action needed unless returned.',
};

/** A seat held this long without a handoff is stale for the PM board. */
export const STALE_HOLD_HOURS = 48;

export function holdAgeHours(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (now - at) / 3_600_000);
}

export function isStaleHold(iso: string | null | undefined, now = Date.now()): boolean {
  const hours = holdAgeHours(iso, now);
  return hours !== null && hours >= STALE_HOLD_HOURS;
}

export function workStateOf(row: { stage: Stage; rubricAssigneeId: string | null; reviewStatus: ReviewStatus | null }): WorkState {
  if (row.stage === 'done') return 'submitted';
  if (row.stage === 'handoff') return 'handoff';
  if (row.stage === 'stability') return 'stability';
  if (row.stage === 'review') return 'in_review';
  if (row.stage === 'rubric' && row.reviewStatus === 'changes_requested') return 'review_returned';
  if (row.stage === 'rubric' && !row.rubricAssigneeId) return 'unassigned';
  return 'preparing';
}
