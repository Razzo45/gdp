/** Postgres jsonb rejects U+0000. Gemini copies encoding glitches into stored grades. */
export function jsonbSafe<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key.replace(/\u0000/g, '')] = walk(nested);
    return out;
  }
  return value;
}
