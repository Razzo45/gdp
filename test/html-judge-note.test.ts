import { describe, expect, it } from 'vitest';
import { htmlVisualJudgeNote } from '@/lib/ai/htmlJudgeNote';

describe('htmlVisualJudgeNote', () => {
  it('requires a visible screenshot before source can Yes a visual or WebGL claim', () => {
    const note = htmlVisualJudgeNote({
      hasScreenshots: true,
      views: 'desktop 1440px wide, full page up to 4500px tall; phone 390px wide, first screen',
    });
    expect(note).toMatch(/screenshots first/i);
    expect(note).toMatch(/Yes only if it is visible in a screenshot/i);
    expect(note).not.toMatch(/check the source for them/i);
    expect(note).toMatch(/cannot turn a missing or broken visual into a Yes/i);
  });

  it('answers visual and gameplay claims No when the page could not be rendered', () => {
    const note = htmlVisualJudgeNote({ hasScreenshots: false });
    expect(note).toMatch(/no screenshot/i);
    expect(note).toMatch(/Answer visual, canvas, WebGL, three\.js, animation, and gameplay statements No/i);
    expect(note).not.toMatch(/source only where the markup states them explicitly/i);
  });
});
