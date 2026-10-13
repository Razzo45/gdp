import { describe, expect, it } from 'vitest';
import { parseImport, parsePasteLines, preparePastedSeats } from '@/domain/import';
import { countFamilies, quotaSpread } from '@/domain/rubric';

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

describe('preparePastedSeats', () => {
  it('keeps a chosen Visual tag when the wording also reads as Format', () => {
    const rows = preparePastedSeats([
      { tag: 'Visual - Layout', statement: 'The five connected carousel images remain readable at 1080 x 1350 px.' },
      { tag: 'Format/File', statement: 'The delivered presentation uses a 16:9 page size.' },
    ]);
    expect(rows[0]).toMatchObject({ tag: 'Visual - Layout', family: 'visual' });
    expect(rows[1]).toMatchObject({ tag: 'Format/File', family: 'format' });
    expect(quotaSpread(countFamilies(rows)).extra.format).toBe(0);
  });
});

describe('parsePasteLines', () => {
  it('keeps statements untagged unless a Tag | prefix is present', () => {
    const { rows, skipped } = parsePasteLines(`
The deck names the client.
Format/File | The export is a 16:9 PPTX with embedded fonts.
- short
`);
    expect(skipped).toEqual(['- short']);
    expect(rows).toEqual([
      { statement: 'The deck names the client.', suggestedTag: null },
      { statement: 'The export is a 16:9 PPTX with embedded fonts.', suggestedTag: 'Format/File' },
    ]);
  });
});
