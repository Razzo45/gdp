/**
 * How often each surface asks the server for new data.
 *
 * Task panels do not tick. A cheap pulse watches stage, seats and job
 * status; the full view reloads only when one of those changes.
 * Admin / PM boards (dashboard, submissions, Who holds what) refresh on
 * a long interval — minutes, not seconds.
 */

/** While a job is live, ask whether its status changed. */
export const TASK_STATUS_PULSE_MS = 15_000;

/** Dashboard, submissions list, and Who holds what. */
export const BOARD_REFRESH_MS = 7 * 60_000;

/** Coming back to a board tab older than this triggers a refresh. */
export const BOARD_STALE_MS = 5 * 60_000;

export type StatusPulse = {
  stage: string;
  reviewStatus: string | null;
  handoffStatus: string | null;
  rubricAssigneeId: string | null;
  reviewerId: string | null;
  revision: number;
  jobs: readonly { id: string; status: string }[];
};

export function statusKey(pulse: StatusPulse): string {
  return [
    pulse.stage,
    pulse.reviewStatus ?? '',
    pulse.handoffStatus ?? '',
    pulse.rubricAssigneeId ?? '',
    pulse.reviewerId ?? '',
    String(pulse.revision),
    pulse.jobs.map((job) => `${job.id}:${job.status}`).join(','),
  ].join('|');
}

export function statusFromView(view: { submission: Omit<StatusPulse, 'jobs'>; jobs: StatusPulse['jobs'] }): StatusPulse {
  return {
    stage: view.submission.stage,
    reviewStatus: view.submission.reviewStatus,
    handoffStatus: view.submission.handoffStatus,
    rubricAssigneeId: view.submission.rubricAssigneeId,
    reviewerId: view.submission.reviewerId,
    revision: view.submission.revision,
    jobs: view.jobs.map((job) => ({ id: job.id, status: job.status })),
  };
}
