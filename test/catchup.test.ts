import { describe, expect, it } from 'vitest';
import { canReplaceWatches, catchupExistingValues } from '@/domain/catchup';

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
