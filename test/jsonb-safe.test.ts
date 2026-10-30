import { describe, expect, it } from 'vitest';
import { jsonbSafe } from '@/domain/jsonbSafe';

describe('jsonbSafe', () => {
  it('strips NUL bytes that Postgres jsonb cannot store', () => {
    expect(jsonbSafe({ text: 'Plant\u0000derived', nested: ['ok', 'a\u0000b'] })).toEqual({
      text: 'Plantderived',
      nested: ['ok', 'ab'],
    });
  });
});
