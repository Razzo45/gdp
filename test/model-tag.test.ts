import { describe, expect, it } from 'vitest';
import { inferModelTag, isActiveModelTag, isActiveModelWork, modelTagFromValues, MODEL_TAG_LABEL } from '@/domain/modelTag';

describe('inferModelTag', () => {
  it('reads Argon from the first acceptance line', () => {
    expect(inferModelTag('ARGON\nMust be a PPTX')).toBe('argon');
    expect(inferModelTag('FOR ARGON\nSlide count is 12')).toBe('argon');
    expect(inferModelTag('For Argon — HTML desktop prototype')).toBe('argon');
    expect(inferModelTag('1. ARGON\nDeliver a WAV')).toBe('argon');
  });

  it('reads Carbon from the first acceptance line', () => {
    expect(inferModelTag('CARBON\nMust be a PPTX')).toBe('carbon');
    expect(inferModelTag('FOR CARBON\nUse brand colors')).toBe('carbon');
    expect(inferModelTag('for carbon: video ads')).toBe('carbon');
  });

  it('defaults to Gemini 3.8 when the first line has no Argon/Carbon marker', () => {
    expect(inferModelTag('Is the finished ad a WAV?\nDuration 30s')).toBe('gemini_38');
    expect(inferModelTag('')).toBe('gemini_38');
    expect(inferModelTag('   \n\n')).toBe('gemini_38');
  });

  it('does not retag from Argon/Carbon mentioned only later in the list', () => {
    expect(inferModelTag('Deliver a native PPTX\nDo not mention argon in the deck')).toBe('gemini_38');
  });
});

describe('modelTagFromValues', () => {
  it('uses Catalog acceptanceCriteria first line', () => {
    expect(modelTagFromValues({ acceptanceCriteria: 'FOR ARGON\nMore rules' })).toBe('argon');
    expect(modelTagFromValues({ acceptanceCriteria: 'CARBON\nMore' })).toBe('carbon');
    expect(modelTagFromValues({})).toBe('gemini_38');
  });

  it('falls back to creatorAcceptanceCriteria when the main field is empty', () => {
    expect(modelTagFromValues({ acceptanceCriteria: '  ', creatorAcceptanceCriteria: 'ARGON\nExtra' })).toBe('argon');
  });
});

describe('modelTagFromSource', () => {
  it('reads nested Catalog submission values', async () => {
    const { modelTagFromSource } = await import('@/lib/catalog/read');
    expect(
      modelTagFromSource({
        submission: { projectSubmissionId: 'x', submission: { acceptanceCriteria: 'FOR CARBON\nDone' } },
      }),
    ).toBe('carbon');
    expect(modelTagFromSource({ submission: { acceptanceCriteria: 'ARGON' } })).toBe('argon');
    expect(modelTagFromSource({})).toBe('gemini_38');
  });
});

describe('active model helpers', () => {
  it('treats only Argon and Carbon as active development work', () => {
    expect(isActiveModelTag('argon')).toBe(true);
    expect(isActiveModelTag('carbon')).toBe(true);
    expect(isActiveModelTag('gemini_38')).toBe(false);
    expect(isActiveModelWork({ modelTag: 'argon' })).toBe(true);
    expect(isActiveModelWork({ modelTag: 'gemini_38' })).toBe(false);
    expect(isActiveModelWork({ modelTag: null })).toBe(false);
  });

  it('labels tags for the UI', () => {
    expect(MODEL_TAG_LABEL.argon).toBe('Argon');
    expect(MODEL_TAG_LABEL.carbon).toBe('Carbon');
    expect(MODEL_TAG_LABEL.gemini_38).toBe('Gemini 3.8');
  });
});
