import { describe, expect, it } from 'vitest';
import { AUTOCOOK_OPERATOR_EMAIL, brainFromModelTag, canAutocookEmail, cookPromptFromFields, mediaPathFromAbs, operatorCookFromRun } from '@/domain/autocook';

describe('operatorCookFromRun', () => {
  it('keeps an active cook and its status line', () => {
    const row = operatorCookFromRun({
      id: 'run_e5a063de',
      session_id: 'sess_drama_gdp-eeb7dc91',
      status: 'generating',
      error: 'Argon tool join_videos (tokyo_top_5_video-joined, 10 clips)…',
      live: { text: 'Argon tool join_videos (tokyo_top_5_video-joined, 10 clips)…' },
      updated_at: '2026-11-16T12:27:41.025Z',
      initial_prompt: 'Make the film',
    });
    expect(row?.active).toBe(true);
    expect(row?.brain).toBe('Argon');
    expect(row?.line).toMatch(/join_videos/);
    expect(row?.id).toBe('run_e5a063de');
  });

  it('drops a row that is not a run id', () => {
    expect(operatorCookFromRun({ id: 'not-a-run', status: 'queued' })).toBeNull();
  });

  it('reads a carbon model id as Carbon', () => {
    const row = operatorCookFromRun({ id: 'run_393d219f', status: 'generating', script_model: 'gemini-4-carbon' });
    expect(row?.brain).toBe('Carbon');
  });

  it('marks an exported cook finished', () => {
    const row = operatorCookFromRun({ id: 'run_53e150b9', status: 'exported', live: { text: 'Exported' } });
    expect(row?.active).toBe(false);
  });
});

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
