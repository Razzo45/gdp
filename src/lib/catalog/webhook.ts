import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Catalog deliveries are signed `keyId=…,sha256=<hex>` over
 * `<timestamp>.<raw body>` with HMAC-SHA256. The body must be the exact bytes
 * received; re-serialised JSON does not reproduce the digest.
 */
export function readSignature(header: string | null): { keyId: string; digest: string } | null {
  if (header === null) return null;
  let keyId = '';
  let digest = '';
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 'keyId') keyId = value;
    if (name === 'sha256') digest = value.toLowerCase();
  }
  return /^[0-9a-f]{64}$/.test(digest) ? { keyId, digest } : null;
}

function keyFor(secret: string): string | Buffer {
  if (secret.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length > 0 && decoded.toString('base64') === secret) return decoded;
  }
  return secret;
}

export function signatureMatches(digest: string, body: string, timestamp: string, secret: string): boolean {
  if (secret === '') return false;
  const expected = createHmac('sha256', keyFor(secret)).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  const left = Buffer.from(digest, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function timestampFresh(timestamp: string, now = Date.now(), windowMs = 5 * 60_000): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  return Math.abs(now - Number(timestamp) * 1000) <= windowMs;
}
