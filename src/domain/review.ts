/** Request-revisions note. UI and decideReview must use the same floor. */
export const REVIEW_NOTE_MIN_CHARS = 10;

/** A claimed reviewer can always change answers. Submit records a score; it does not lock the seat. */
export function reviewGradesEditable(input: { holdsReviewSeat: boolean; submitted?: boolean }): boolean {
  return input.holdsReviewSeat;
}

/** Keep the fuller saved draft when a stale tab flushes two seats over fifty. */
export function mergeReviewDraft(
  existing: { answers: Record<string, boolean>; evidence: Record<string, string> } | null,
  incoming: { answers: Record<string, boolean>; evidence: Record<string, string> },
): { answers: Record<string, boolean>; evidence: Record<string, string> } {
  if (!existing) return incoming;
  return {
    answers: { ...existing.answers, ...incoming.answers },
    evidence: { ...existing.evidence, ...incoming.evidence },
  };
}

/** Prefer the current complete pass. Fall back to the last submitted score. */
export function reviewApprovalScore(input: { latestCompletePercent: number | null; submittedPercent: number | null }): number | null {
  return input.latestCompletePercent ?? input.submittedPercent;
}

/** The creator sees the latest return note only while the task is back on the rubric. */
export function reviewerReturnNote(input: {
  stage: string;
  feedback: { decision: string; feedback: string }[];
}): { message: string } | null {
  if (input.stage !== 'rubric') return null;
  const latest = input.feedback[0];
  if (latest?.decision !== 'changes_requested') return null;
  const message = latest.feedback.trim();
  if (!message) return null;
  return { message };
}
