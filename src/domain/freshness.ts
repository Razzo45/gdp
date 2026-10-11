/**
 * How often each surface asks the server for new data.
 *
 * Task panels do not tick. A cheap pulse watches stage, seats, job
 * status, and job progress; the full view reloads when one of those changes.
 * Admin / PM boards (dashboard, submissions, Who holds what) refresh on
 * a long interval — minutes, not seconds.
 */

/** While a job is live, ask whether its status or progress changed. */
export const TASK_STATUS_PULSE_MS = 1_000;

/** Dashboard, submissions list, and Who holds what. */
export const BOARD_REFRESH_MS = 7 * 60_000;

/** Coming back to a board tab older than this triggers a refresh. */
export const BOARD_STALE_MS = 5 * 60_000;

export type PulseJob = {
  id: string;
  status: string;
  progressKey?: string;
};

export type StatusPulse = {
  stage: string;
  reviewStatus: string | null;
  handoffStatus: string | null;
  rubricAssigneeId: string | null;
  reviewerId: string | null;
  revision: number;
  jobs: readonly PulseJob[];
};

export function jobProgressView(job: {
  kind: string;
  status: string;
  progress?: { note?: string; done?: number; total?: number } | null;
}): { title: string; ratio: number; detail: string | null } {
  const progress = job.progress ?? {};
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const title =
    progress.note ||
    (job.kind === 'golden_autorate'
      ? job.status === 'queued'
        ? 'Golden autorate queued'
        : 'Starting Golden…'
      : job.status === 'queued'
        ? 'Queued'
        : 'Working');
  const ratio = total > 0 ? Math.min(1, done / total) : job.status === 'running' ? 0.15 : 0;
  const detail = job.kind === 'golden_autorate' && total > 0 ? `${done} of ${total} seats` : null;
  return { title, ratio, detail };
}

export function progressKeyOf(progress: { note?: string; done?: number; total?: number; passes?: Record<string, number | null> } | null | undefined): string {
  if (!progress) return '';
  const passes = progress.passes ? Object.entries(progress.passes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v ?? ''}`).join(',') : '';
  return [progress.note ?? '', progress.done ?? '', progress.total ?? '', passes].join(':');
}

export function statusKey(pulse: StatusPulse): string {
  return [
    pulse.stage,
    pulse.reviewStatus ?? '',
    pulse.handoffStatus ?? '',
    pulse.rubricAssigneeId ?? '',
    pulse.reviewerId ?? '',
    String(pulse.revision),
    pulse.jobs.map((job) => `${job.id}:${job.status}:${job.progressKey ?? ''}`).join(','),
  ].join('|');
}

export function statusFromView(view: {
  submission: Omit<StatusPulse, 'jobs'>;
  jobs: readonly { id: string; status: string; progress?: { note?: string; done?: number; total?: number; passes?: Record<string, number | null> } | null }[];
}): StatusPulse {
  return {
    stage: view.submission.stage,
    reviewStatus: view.submission.reviewStatus,
    handoffStatus: view.submission.handoffStatus,
    rubricAssigneeId: view.submission.rubricAssigneeId,
    reviewerId: view.submission.reviewerId,
    revision: view.submission.revision,
    jobs: view.jobs.map((job) => ({ id: job.id, status: job.status, progressKey: progressKeyOf(job.progress) })),
  };
}
