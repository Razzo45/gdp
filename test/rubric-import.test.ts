import { describe, expect, it } from 'vitest';
import { parseImport } from '@/domain/import';

describe('parseImport', () => {
  it('turns numbered questions into affirmative statements and honours a tag prefix', () => {
    const { rows, skipped } = parseImport(`
1. Does the deck use the brand palette?
Format/File | The export is a 16:9 PPTX with embedded fonts.
- short
s003: Every slide has one clear headline
`);
    expect(skipped).toEqual(['- short']);
    expect(rows.map((r) => r.statement)).toEqual([
      'The deck use the brand palette.',
      'The export is a 16:9 PPTX with embedded fonts.',
      'Every slide has one clear headline.',
    ]);
    expect(rows[1]?.tag).toBe('Format/File');
  });

  it('skips empty lines and too-short leftovers', () => {
    expect(parseImport('\n\n  \nHi\n').rows).toEqual([]);
  });
});
