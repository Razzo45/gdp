import { createHmac, timingSafeEqual } from 'node:crypto';

/** 32 hex chars — same length the legacy modules.wirestock.io links used. */
export function viewTaskToken(secret: string, submissionId: string): string {
  return createHmac('sha256', secret).update(`view-task\n${submissionId}`).digest('hex').slice(0, 32);
}

export function viewTaskTokenMatches(secret: string, submissionId: string, token: string): boolean {
  if (!secret || !/^[0-9a-f]{32}$/i.test(token)) return false;
  const expected = Buffer.from(viewTaskToken(secret, submissionId), 'hex');
  const given = Buffer.from(token, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Public HTTPS share URL, or null when we must not put a localhost link on Catalog. */
export function viewTaskHref(baseUrl: string, submissionId: string, token: string): string | null {
  const base = baseUrl.trim().replace(/\/$/, '');
  if (!base || !/^https:\/\//i.test(base) || !submissionId || !token) return null;
  return `${base}/s/${encodeURIComponent(submissionId)}?t=${token}`;
}
