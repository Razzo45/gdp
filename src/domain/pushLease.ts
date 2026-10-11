/** Push lock on `submissions.push_receipt`. A crash must not block the task forever. */
export const PUSH_LEASE_MS = 10 * 60_000;

export function isCompletedPushReceipt(receipt: unknown): boolean {
  return Boolean(receipt && typeof receipt === 'object' && 'moves' in receipt);
}

/** True while another click still owns the Catalog write. */
export function isLivePushLease(receipt: unknown, now = Date.now()): boolean {
  if (!receipt || typeof receipt !== 'object' || isCompletedPushReceipt(receipt)) return false;
  const leaseAt = (receipt as { leaseAt?: unknown }).leaseAt;
  if (typeof leaseAt !== 'string') return false;
  const at = Date.parse(leaseAt);
  return Number.isFinite(at) && now - at < PUSH_LEASE_MS;
}
