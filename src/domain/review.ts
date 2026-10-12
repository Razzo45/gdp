/** A claimed reviewer can always change answers. Submit records a score; it does not lock the seat. */
export function reviewGradesEditable(input: { holdsReviewSeat: boolean; submitted?: boolean }): boolean {
  return input.holdsReviewSeat;
}

/** Prefer the current complete pass. Fall back to the last submitted score. */
export function reviewApprovalScore(input: { latestCompletePercent: number | null; submittedPercent: number | null }): number | null {
  return input.latestCompletePercent ?? input.submittedPercent;
}
