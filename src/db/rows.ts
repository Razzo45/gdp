/**
 * `db.execute()` returns a RowList (array) under postgres-js and `{ rows }`
 * under pglite. Normalize so raw SQL reads work on both.
 */
export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
