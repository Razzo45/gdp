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
