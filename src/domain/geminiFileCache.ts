/**
 * What to do with a cached Files API handle after `files.get`.
 * A transient get failure must not drop the row — that re-uploads a 2 GB file.
 * 403/404 are not transient: the file expired or was staged under a different API key.
 */
export function cachedGeminiUriDecision(input: { getFailed: boolean; status?: number; state?: string | null; uri?: string | null }): 'use' | 'keep' | 'drop' {
  if (input.getFailed) return input.status === 403 || input.status === 404 ? 'drop' : 'keep';
  const state = (input.state ?? '').toUpperCase();
  if (state === 'ACTIVE' && input.uri) return 'use';
  if (state === 'PROCESSING') return 'keep';
  return 'drop';
}
