import { describe, expect, it } from 'vitest';
import { holdAgeHours, isStaleHold, STALE_HOLD_HOURS } from '@/domain/workState';

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
});
