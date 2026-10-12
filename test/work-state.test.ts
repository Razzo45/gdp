import { describe, expect, it } from 'vitest';
import { holdAgeHours, isStaleHold, platformStateChangedAt, seatIsStale, STALE_HOLD_HOURS } from '@/domain/workState';

describe('hold aging', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');

  it('is not stale when the seat has no claim time', () => {
    expect(holdAgeHours(null, now)).toBeNull();
    expect(isStaleHold(undefined, now)).toBe(false);
    expect(isStaleHold('not-a-date', now)).toBe(false);
  });

  it('is stale at 48 hours, not before', () => {
    expect(STALE_HOLD_HOURS).toBe(48);
    expect(holdAgeHours(new Date(now - 10 * 3_600_000).toISOString(), now)).toBe(10);
    expect(isStaleHold(new Date(now - 47 * 3_600_000).toISOString(), now)).toBe(false);
    expect(isStaleHold(new Date(now - 48 * 3_600_000).toISOString(), now)).toBe(true);
    expect(isStaleHold(new Date(now - 72 * 3_600_000).toISOString(), now)).toBe(true);
  });

  it('does not mark a delivered seat stale', () => {
    const claimed = new Date(now - 72 * 3_600_000).toISOString();
    expect(seatIsStale({ claimedAt: claimed, stage: 'done' }, now)).toBe(false);
    expect(seatIsStale({ claimedAt: claimed, stage: 'rubric' }, now)).toBe(true);
  });
});

describe('platform state changed', () => {
  it('uses the last upstream move, or landed if the status has not moved', () => {
    expect(platformStateChangedAt({ landedAt: '2026-10-01T00:00:00.000Z', upstreamChangedAt: null })).toBe('2026-10-01T00:00:00.000Z');
    expect(platformStateChangedAt({ landedAt: '2026-10-01T00:00:00.000Z', upstreamChangedAt: '2026-10-08T12:00:00.000Z' })).toBe('2026-10-08T12:00:00.000Z');
  });
});
