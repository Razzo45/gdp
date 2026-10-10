import { createHash } from 'node:crypto';

/** Stable JSON: sorted keys, no undefined. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, inner]) => [k, walk(inner)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

const VOLATILE_QUERY = /^(x-amz-|amz-|signature$|expires$|x-goog-|goog-)/i;

/**
 * Presigned S3 URLs change on every read. Strip signing parameters so two
 * reads of the same unchanged object fingerprint identically; a replaced path
 * still reads as a change.
 */
export function stripVolatileUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (VOLATILE_QUERY.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function stripVolatile(value: unknown): unknown {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? stripVolatileUrl(value) : value;
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripVolatile(v)]));
  }
  return value;
}

export function sourceFingerprint(payload: unknown): string {
  return fingerprint(stripVolatile(payload));
}

/** What a grading job binds to: wording and file scope, nothing else. */
export function statementHash(input: {
  statement: string;
  scope: 'output' | 'inputs';
  inputFileIds: readonly string[];
  outputFile: string | null;
}): string {
  return sha256(
    JSON.stringify({
      s: input.statement.trim(),
      sc: input.scope,
      i: [...input.inputFileIds].sort(),
      o: input.outputFile ?? '',
    }),
  );
}
