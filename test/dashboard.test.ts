import { describe, expect, it } from 'vitest';
import { countIn, isStuckStatus, isUserInteraction, lastUserInteractionAt, latestEntryAt, statusEnteredAt, teamSignal } from '@/domain/dashboard';

const now = Date.parse('2026-10-10T12:00:00.000Z');

describe('countIn', () => {
  it('buckets stamps into today, week, month, and all', () => {
    const counts = countIn(
      ['2026-10-10T08:00:00.000Z', '2026-10-08T08:00:00.000Z', '2026-09-01T08:00:00.000Z', null],
      now,
    );
    expect(counts).toEqual({ today: 1, week: 2, month: 2, all: 3 });
  });
});

describe('stuck status', () => {
  it('uses the latest matching entry event', () => {
    expect(
      latestEntryAt('preparing', [
        { action: 'rubric_claimed', createdAt: '2026-10-08T00:00:00.000Z' },
        { action: 'sent_to_review', createdAt: '2026-10-09T00:00:00.000Z' },
        { action: 'rubric_assigned', createdAt: '2026-10-07T00:00:00.000Z' },
      ]),
    ).toBe('2026-10-08T00:00:00.000Z');
  });

  it('falls back to the claim time and flags 24 hours', () => {
    const entered = statusEnteredAt(
      {
        workState: 'preparing',
        landedAt: '2026-10-01T00:00:00.000Z',
        rubricClaimedAt: '2026-10-09T11:00:00.000Z',
        reviewClaimedAt: null,
        lastClaimedAt: '2026-10-09T11:00:00.000Z',
        updatedAt: '2026-10-09T11:00:00.000Z',
        pushedAt: null,
      },
      null,
    );
    expect(entered).toBe('2026-10-09T11:00:00.000Z');
    expect(isStuckStatus('2026-10-09T13:00:00.000Z', now)).toBe(false);
    expect(isStuckStatus('2026-10-09T12:00:00.000Z', now)).toBe(true);
  });
});

describe('lastUserInteractionAt', () => {
  it('ignores catalog refreshes and actor-less syncs', () => {
    expect(
      lastUserInteractionAt([
        { action: 'upstream_changed', actorId: 'user-1', createdAt: '2026-10-10T12:00:00.000Z' },
        { action: 'landed', actorId: null, createdAt: '2026-10-10T11:00:00.000Z' },
        { action: 'rubric_claimed', actorId: 'user-1', createdAt: '2026-10-09T11:00:00.000Z' },
        { action: 'sent_to_review', actorId: 'user-1', createdAt: '2026-10-09T15:00:00.000Z' },
      ]),
    ).toBe('2026-10-09T15:00:00.000Z');
    expect(isUserInteraction({ action: 'upstream_changed', actorId: 'user-1' })).toBe(false);
    expect(isUserInteraction({ action: 'rubric_claimed', actorId: null })).toBe(false);
  });
});

describe('teamSignal', () => {
  it('puts stuck people first, then movers, then quiet', () => {
    expect(teamSignal({ stuck: 1, weekMoves: 4 })).toBe('attention');
    expect(teamSignal({ stuck: 0, weekMoves: 2 })).toBe('moving');
    expect(teamSignal({ stuck: 0, weekMoves: 0 })).toBe('quiet');
  });
});
