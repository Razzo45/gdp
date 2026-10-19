import { describe, expect, it } from 'vitest';
import { boardListRows, handoffAfterContinue, holdAgeHours, isStaleHold, platformStateChangedAt, reviewAdvanceAfterApprove, seatIsStale, STALE_HOLD_HOURS, workStateOf } from '@/domain/workState';

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

describe('reviewAdvanceAfterApprove', () => {
  it('skips Stability and opens Ready to submit when Stability is already accepted and still passing', () => {
    expect(reviewAdvanceAfterApprove({ handoffStatus: 'bounced', stabilityAccepted: true, stabilityOk: true })).toEqual({
      stage: 'handoff',
      handoffStatus: 'stability_pass',
    });
    expect(reviewAdvanceAfterApprove({ handoffStatus: null, stabilityAccepted: false, stabilityOk: true })).toEqual({
      stage: 'stability',
      handoffStatus: null,
    });
    expect(reviewAdvanceAfterApprove({ handoffStatus: 'bounced', stabilityAccepted: true, stabilityOk: false })).toEqual({
      stage: 'stability',
      handoffStatus: null,
    });
  });
});

describe('handoffAfterContinue', () => {
  it('drops a Catalog bounce so the task can leave Platform returned', () => {
    expect(handoffAfterContinue('bounced')).toBeNull();
    expect(handoffAfterContinue('stability_pass')).toBe('stability_pass');
    expect(handoffAfterContinue(null)).toBeNull();
    expect(workStateOf({ stage: 'review', rubricAssigneeId: 'x', reviewStatus: 'pending', handoffStatus: handoffAfterContinue('bounced') })).toBe('in_review');
  });
});

describe('platform state changed', () => {
  it('uses the last upstream move, or landed if the status has not moved', () => {
    expect(platformStateChangedAt({ landedAt: '2026-10-01T00:00:00.000Z', upstreamChangedAt: null })).toBe('2026-10-01T00:00:00.000Z');
    expect(platformStateChangedAt({ landedAt: '2026-10-01T00:00:00.000Z', upstreamChangedAt: '2026-10-08T12:00:00.000Z' })).toBe('2026-10-08T12:00:00.000Z');
  });
});

describe('boardListRows', () => {
  const rows = [
    { id: 'prep', workState: 'preparing' as const },
    { id: 'rev', workState: 'in_review' as const },
    { id: 'ret', workState: 'platform_returned' as const },
  ];

  it('keeps a panel filter when there is no search', () => {
    expect(boardListRows(rows, { workState: 'platform_returned' }).map((r) => r.id)).toEqual(['ret']);
  });

  it('returns every match when searching, even if a panel is still selected', () => {
    expect(boardListRows(rows, { workState: 'platform_returned', q: '86856d80' }).map((r) => r.id)).toEqual(['prep', 'rev', 'ret']);
  });
});
