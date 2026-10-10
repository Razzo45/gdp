/** Stages where Gemini will not be called again unless the task is bounced back. */
export const GRADING_DONE_STAGES = ['handoff', 'done'] as const;

export const REAP_GRACE_MS = 10 * 60_000;

export function isHandleExpired(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= nowMs + REAP_GRACE_MS;
}

/**
 * A staged Files API handle can go when:
 *  - Gemini is about to drop it anyway (≤10 minutes left), or
 *  - every task that used it has finished grading (handoff/done) and none of
 *    those tasks still has a queued/running job.
 *
 * A handle with no recorded uses is only culled on expiry — it may belong to
 * a job that started before we tracked uses.
 */
export function reapableShas(input: {
  files: { sha256: string; expiresAt: string }[];
  uses: { sha256: string; submissionId: string }[];
  stages: { id: string; stage: string }[];
  busySubmissionIds: Iterable<string>;
  nowMs: number;
}): string[] {
  const stageById = new Map(input.stages.map((row) => [row.id, row.stage]));
  const busy = new Set(input.busySubmissionIds);
  const users = new Map<string, string[]>();
  for (const use of input.uses) {
    const list = users.get(use.sha256) ?? [];
    list.push(use.submissionId);
    users.set(use.sha256, list);
  }
  const out: string[] = [];
  for (const file of input.files) {
    if (isHandleExpired(file.expiresAt, input.nowMs)) {
      out.push(file.sha256);
      continue;
    }
    const owners = users.get(file.sha256);
    if (!owners?.length) continue;
    if (owners.some((id) => busy.has(id))) continue;
    if (owners.every((id) => (GRADING_DONE_STAGES as readonly string[]).includes(stageById.get(id) ?? ''))) {
      out.push(file.sha256);
    }
  }
  return out;
}
