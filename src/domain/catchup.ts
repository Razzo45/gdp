import type { HandoffStatus, ReviewStatus, Stage } from '@/db/schema';

/** Fields catchup must not take from live once a task already lives on Railway. */
export type CatchupPipeline = {
  stage: Stage;
  reviewStatus: ReviewStatus | null;
  handoffStatus: HandoffStatus | null;
  rubricAssigneeId: string | null;
  reviewerId: string | null;
};

/**
 * Refresh Catalog metadata, keep the Railway pipeline.
 * Catchup is read-live / write-Railway. It must not park or reassign work we already own.
 */
export function catchupExistingValues<T extends CatchupPipeline>(existing: CatchupPipeline, incoming: T): T {
  return {
    ...incoming,
    stage: existing.stage,
    reviewStatus: existing.reviewStatus,
    handoffStatus: existing.handoffStatus,
    rubricAssigneeId: existing.rubricAssigneeId,
    reviewerId: existing.reviewerId,
  };
}

/** An empty live watch list is a missing table or a failed read — not a wipe. */
export function canReplaceWatches(liveProjectIds: readonly string[]): boolean {
  return liveProjectIds.length > 0;
}

export type RecoveredPipeline = {
  stage: Stage;
  reviewStatus: ReviewStatus | null;
  handoffStatus: HandoffStatus | null;
};

/**
 * Catchup parked rows from Catalog lane. Restore the GDP stage from our
 * own events, then live review/handoff/eval. Seats are left alone.
 */
export function recoverParkedPipeline(input: {
  events: readonly { action: string; createdAt?: string }[];
  pushedAt?: string | null;
  liveReviewStatus?: ReviewStatus | null;
  liveHandoffStatus?: HandoffStatus | string | null;
  liveGdpState?: string | null;
  hasStabilityAcceptance?: boolean;
  hasSubmittedCalibration?: boolean;
}): RecoveredPipeline {
  if (input.pushedAt || input.liveHandoffStatus === 'client_visible' || input.liveGdpState === 'submitted') {
    return { stage: 'done', reviewStatus: 'approved', handoffStatus: 'client_visible' };
  }
  if (input.liveHandoffStatus === 'bounced') {
    return { stage: 'handoff', reviewStatus: input.liveReviewStatus ?? 'approved', handoffStatus: 'bounced' };
  }
  const ordered = [...input.events].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const recovered = pipelineFromAction(ordered[i]!.action);
    if (recovered) return recovered;
  }
  const liveHandoff = asHandoff(input.liveHandoffStatus);
  if (liveHandoff) return { stage: 'handoff', reviewStatus: input.liveReviewStatus ?? 'approved', handoffStatus: liveHandoff };
  if (input.hasStabilityAcceptance) return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: null };
  if (input.liveReviewStatus === 'approved' || input.liveGdpState === 'approved' || input.liveGdpState === 'accepted') {
    return { stage: 'stability', reviewStatus: 'approved', handoffStatus: null };
  }
  if (input.liveReviewStatus === 'pending' || input.hasSubmittedCalibration || input.liveGdpState === 'in_review') {
    return { stage: 'review', reviewStatus: 'pending', handoffStatus: null };
  }
  if (input.liveReviewStatus === 'changes_requested') {
    return { stage: 'rubric', reviewStatus: 'changes_requested', handoffStatus: null };
  }
  return { stage: 'rubric', reviewStatus: null, handoffStatus: null };
}

function asHandoff(value: string | null | undefined): HandoffStatus | null {
  if (
    value === 'ready_for_review' ||
    value === 'bounced' ||
    value === 'stability_pass' ||
    value === 'final_review_pass' ||
    value === 'client_visible'
  ) {
    return value;
  }
  return null;
}

function pipelineFromAction(action: string): RecoveredPipeline | null {
  if (action === 'pushed_to_catalog') return { stage: 'done', reviewStatus: 'approved', handoffStatus: 'client_visible' };
  if (action === 'handoff_final_review_pass') return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: 'final_review_pass' };
  if (action === 'handoff_stability_pass') return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: 'stability_pass' };
  if (action === 'handoff_ready_for_review') return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: 'ready_for_review' };
  if (action === 'handoff_bounced') return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: 'bounced' };
  if (action === 'stability_accepted') return { stage: 'handoff', reviewStatus: 'approved', handoffStatus: null };
  if (action === 'stability_reopened_rubric' || action === 'review_changes_requested') {
    return { stage: 'rubric', reviewStatus: 'changes_requested', handoffStatus: null };
  }
  if (action === 'review_approved') return { stage: 'stability', reviewStatus: 'approved', handoffStatus: null };
  if (action === 'sent_to_review' || action === 'review_claimed' || action === 'review_assigned' || action === 'calibration_submitted') {
    return { stage: 'review', reviewStatus: 'pending', handoffStatus: null };
  }
  return null;
}
