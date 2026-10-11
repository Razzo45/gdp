import { describe, expect, it } from 'vitest';
import { isCompletedPushReceipt, isLivePushLease, PUSH_LEASE_MS } from '@/domain/pushLease';

describe('push lease', () => {
  it('treats a fresh lease as live and an old one as expired', () => {
    const now = Date.parse('2026-10-11T12:00:00.000Z');
    expect(isLivePushLease({ leaseBy: 'u', leaseAt: '2026-10-11T11:55:00.000Z' }, now)).toBe(true);
    expect(isLivePushLease({ leaseBy: 'u', leaseAt: '2026-10-11T11:40:00.000Z' }, now)).toBe(false);
    expect(now - Date.parse('2026-10-11T11:40:00.000Z')).toBeGreaterThan(PUSH_LEASE_MS);
  });

  it('does not treat a completed receipt as a live lease', () => {
    const receipt = { by: 'u', at: '2026-10-11T12:00:00.000Z', moves: ['handoff'], rubricItems: 4 };
    expect(isCompletedPushReceipt(receipt)).toBe(true);
    expect(isLivePushLease(receipt)).toBe(false);
    expect(isLivePushLease(null)).toBe(false);
  });
});
