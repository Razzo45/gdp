/**
 * What to do with a cached Files API handle after `files.get`.
 * A transient get failure must not drop the row — that re-uploads a 2 GB file.
 */
export function cachedGeminiUriDecision(input: { getFailed: boolean; state?: string | null; uri?: string | null }): 'use' | 'keep' | 'drop' {
  if (input.getFailed) return 'keep';
  const state = (input.state ?? '').toUpperCase();
  if (state === 'ACTIVE' && input.uri) return 'use';
  if (state === 'PROCESSING') return 'keep';
  return 'drop';
}
