import { describe, expect, it } from 'vitest';
import { CUTOVER_KEEP_PREFIXES, keepCatalogId } from '@/domain/cutoverKeep';

describe('keepCatalogId', () => {
  it('keeps the named freeze tasks by Catalog UUID prefix and ignores the rest', () => {
    expect(CUTOVER_KEEP_PREFIXES).toHaveLength(29);
    expect(keepCatalogId('22c685ba-9465-4fe4-83a9-d984fba972fa')).toBe(true);
    expect(keepCatalogId('1704127a-1111-4111-8111-111111111111')).toBe(true);
    expect(keepCatalogId('e7553a93-ecc0-4d99-aa07-49872422d346')).toBe(false);
    expect(keepCatalogId('')).toBe(false);
  });
});
