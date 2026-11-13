import { describe, expect, it } from 'vitest';
import { AUTOCOOK_OPERATOR_EMAIL, brainFromModelTag, canAutocookEmail, cookPromptFromFields, mediaPathFromAbs } from '@/domain/autocook';

describe('canAutocookEmail', () => {
  it('allows only george@wirestock.io', () => {
    expect(canAutocookEmail('george@wirestock.io')).toBe(true);
    expect(canAutocookEmail('George@Wirestock.io')).toBe(true);
    expect(canAutocookEmail('other@wirestock.io')).toBe(false);
    expect(canAutocookEmail(null)).toBe(false);
  });

  it('names the operator email constant', () => {
    expect(AUTOCOOK_OPERATOR_EMAIL).toBe('george@wirestock.io');
  });
});

describe('brainFromModelTag', () => {
  it('maps Argon and Carbon, and defaults Gemini 3.8 to Argon', () => {
    expect(brainFromModelTag('argon')).toBe('argon');
    expect(brainFromModelTag('carbon')).toBe('carbon');
    expect(brainFromModelTag('gemini_38')).toBe('argon');
    expect(brainFromModelTag(null)).toBe('argon');
  });
});

describe('cookPromptFromFields', () => {
  it('joins Catalog labels and text the way the operator pastes the brief', () => {
    expect(
      cookPromptFromFields([
        { label: 'Task', text: 'Make a deck' },
        { label: 'Notes', text: 'Brand red' },
      ]),
    ).toBe('Task:\nMake a deck\n\nNotes:\nBrand red');
  });

  it('skips empty fields', () => {
    expect(cookPromptFromFields([{ label: 'X', text: '  ' }, { label: 'Y', text: 'Keep' }])).toBe('Y:\nKeep');
  });
});

describe('mediaPathFromAbs', () => {
  it('turns an Autocook absolute deliverable path into a runs/ relative media path', () => {
    expect(mediaPathFromAbs('/app/runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('C:\\data\\runs\\run_abc\\final.png')).toBe('runs/run_abc/final.png');
  });
});
