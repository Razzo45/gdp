import { describe, expect, it } from 'vitest';
import { enhancerRowsPerSeed, extractSeedsFromNotes, looksLikeSeedList, shouldExtractNotes } from '@/domain/seeds';

const NOTES = `Rubric Questions
Overarching
1.	Are three (3) Instagram carousel image files and two (2) LinkedIn carousel image files included in the delivered output?
2.	Does all copy correctly spell the name of the brand as: ‘Arvella’?
3.	Is the typography aligned to Arvella Brand standards in using ‘Josefin Sans’?

Instagram Posts
1.	Is each Instagram carousel image at a size of exactly: 1080 px by 1080 px?
2.	Is each Instagram carousel image delivered as a .png file?
15.	Does the mock up resemble the actual Instagram app?

LinkedIn Posts
1.	Is each LinkedIn carousel image at a size of exactly: 1080 px by 1080 px?
10.	Is the copy tone for the ads scholarly, clinical, and data-driven?
`;

describe('extractSeedsFromNotes', () => {
  it('turns every numbered question into a seed and keeps section themes', () => {
    const seeds = extractSeedsFromNotes(NOTES);
    expect(seeds.length).toBe(8);
    expect(seeds.map((s) => s.theme)).toEqual([
      'Overarching',
      'Overarching',
      'Overarching',
      'Instagram Posts',
      'Instagram Posts',
      'Instagram Posts',
      'LinkedIn Posts',
      'LinkedIn Posts',
    ]);
    expect(seeds[0]?.statement).toMatch(/three \(3\) Instagram carousel image files/i);
    expect(seeds[0]?.statement.endsWith('.')).toBe(true);
    expect(seeds.some((s) => /1080 px by 1080 px/i.test(s.statement))).toBe(true);
    expect(seeds.every((s) => !s.statement.includes('?'))).toBe(true);
    expect(seeds.some((s) => s.statement === 'Rubric Questions.')).toBe(false);
  });

  it('does not treat a prose paragraph as a seed list', () => {
    const prose = 'Make a strong rubric covering brand, file delivery, and the two social platforms.';
    expect(looksLikeSeedList(prose)).toBe(false);
    expect(shouldExtractNotes(prose)).toBe(false);
  });

  it('sizes enhancer rows so many seeds still build a bank larger than the seated rubric', () => {
    expect(enhancerRowsPerSeed(9, 50)).toBeGreaterThanOrEqual(12);
    expect(enhancerRowsPerSeed(55, 50)).toBe(3);
    expect(enhancerRowsPerSeed(1, 50)).toBe(40);
  });
});
