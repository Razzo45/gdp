import { describe, expect, it } from 'vitest';
import { canReplaceWatches, catchupExistingValues, recoverParkedPipeline } from '@/domain/catchup';

describe('catchupExistingValues', () => {
  it('keeps Railway stage and seats when live would park the task', () => {
    const existing = {
      stage: 'rubric' as const,
      reviewStatus: null,
      handoffStatus: null,
      rubricAssigneeId: 'creator-1',
      reviewerId: null,
    };
    const incoming = {
      stage: 'parked' as const,
      reviewStatus: 'approved' as const,
      handoffStatus: 'client_visible' as const,
      rubricAssigneeId: null,
      reviewerId: 'reviewer-1',
      title: 'Deck',
      statusId: 'off-board',
    };
    expect(catchupExistingValues(existing, incoming)).toEqual({
      ...incoming,
      stage: 'rubric',
      reviewStatus: null,
      handoffStatus: null,
      rubricAssigneeId: 'creator-1',
      reviewerId: null,
    });
  });
});

describe('canReplaceWatches', () => {
  it('refuses to delete Railway watches when live returned none', () => {
    expect(canReplaceWatches([])).toBe(false);
    expect(canReplaceWatches(['proj-1'])).toBe(true);
  });
});

describe('recoverParkedPipeline', () => {
  it('reads the latest pipeline event, not Catalog parking', () => {
    expect(recoverParkedPipeline({ events: [{ action: 'landed', createdAt: '2026-01-01' }, { action: 'sent_to_review', createdAt: '2026-01-02' }] })).toEqual({
      stage: 'review',
      reviewStatus: 'pending',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [{ action: 'review_approved', createdAt: '2026-01-03' }, { action: 'golden_graded', createdAt: '2026-01-04' }] })).toEqual({
      stage: 'stability',
      reviewStatus: 'approved',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [{ action: 'review_changes_requested', createdAt: '2026-01-03' }] })).toEqual({
      stage: 'rubric',
      reviewStatus: 'changes_requested',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [{ action: 'stability_accepted', createdAt: '2026-01-05' }] })).toEqual({
      stage: 'handoff',
      reviewStatus: 'approved',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [{ action: 'handoff_bounced', createdAt: '2026-01-06' }] })).toEqual({
      stage: 'handoff',
      reviewStatus: 'approved',
      handoffStatus: 'bounced',
    });
    expect(recoverParkedPipeline({ events: [{ action: 'pushed_to_catalog', createdAt: '2026-01-07' }] })).toEqual({
      stage: 'done',
      reviewStatus: 'approved',
      handoffStatus: 'client_visible',
    });
  });

  it('treats a pushed row as submitted even without the event', () => {
    expect(recoverParkedPipeline({ events: [], pushedAt: '2026-01-08T00:00:00.000Z' })).toEqual({
      stage: 'done',
      reviewStatus: 'approved',
      handoffStatus: 'client_visible',
    });
  });

  it('returns parked work to rubric when it only landed', () => {
    expect(recoverParkedPipeline({ events: [{ action: 'landed', createdAt: '2026-01-01' }] })).toEqual({
      stage: 'rubric',
      reviewStatus: null,
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [] })).toEqual({
      stage: 'rubric',
      reviewStatus: null,
      handoffStatus: null,
    });
  });

  it('uses live GDP review when Railway events never recorded the send', () => {
    expect(
      recoverParkedPipeline({
        events: [{ action: 'landed', createdAt: '2026-01-01' }, { action: 'rubric_generated', createdAt: '2026-01-02' }],
        liveReviewStatus: 'approved',
      }),
    ).toEqual({ stage: 'stability', reviewStatus: 'approved', handoffStatus: null });
    expect(recoverParkedPipeline({ events: [], liveReviewStatus: 'pending' })).toEqual({
      stage: 'review',
      reviewStatus: 'pending',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [], liveReviewStatus: 'changes_requested' })).toEqual({
      stage: 'rubric',
      reviewStatus: 'changes_requested',
      handoffStatus: null,
    });
  });

  it('uses live handoff, submitted state, and eval rows when events are thin', () => {
    expect(recoverParkedPipeline({ events: [], liveHandoffStatus: 'bounced' })).toEqual({
      stage: 'handoff',
      reviewStatus: 'approved',
      handoffStatus: 'bounced',
    });
    expect(recoverParkedPipeline({ events: [], liveGdpState: 'submitted' })).toEqual({
      stage: 'done',
      reviewStatus: 'approved',
      handoffStatus: 'client_visible',
    });
    expect(recoverParkedPipeline({ events: [], hasStabilityAcceptance: true })).toEqual({
      stage: 'handoff',
      reviewStatus: 'approved',
      handoffStatus: null,
    });
    expect(recoverParkedPipeline({ events: [], hasSubmittedCalibration: true })).toEqual({
      stage: 'review',
      reviewStatus: 'pending',
      handoffStatus: null,
    });
  });
});
