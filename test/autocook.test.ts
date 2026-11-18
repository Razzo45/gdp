import { describe, expect, it } from 'vitest';
import {
  AUTOCOOK_OPERATOR_EMAIL,
  brainFromModelTag,
  canAutocookEmail,
  cookPhase,
  cookPromptFromFields,
  ingestFilePlan,
  mediaPathFromAbs,
  operatorCookFromRun,
  sortOperatorCooks,
  type OperatorCookRow,
} from '@/domain/autocook';

describe('operatorCookFromRun', () => {
  it('keeps an active cook and its status line', () => {
    const row = operatorCookFromRun({
      id: 'run_e5a063de',
      session_id: 'sess_drama_gdp-eeb7dc91',
      status: 'generating',
      error: 'Argon tool join_videos (tokyo_top_5_video-joined, 10 clips)…',
      live: { text: 'Argon tool join_videos (tokyo_top_5_video-joined, 10 clips)…' },
      created_at: '2026-11-16T11:00:00.000Z',
      updated_at: '2026-11-16T12:27:41.025Z',
      initial_prompt: 'Make the film',
    });
    expect(row?.active).toBe(true);
    expect(row?.brain).toBe('Argon');
    expect(row?.line).toMatch(/join_videos/);
    expect(row?.phase).toBe('Tool · join_videos');
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
    expect(row?.phase).toBe('Done');
  });
});

describe('cookPhase', () => {
  it('names the live steps an operator can read', () => {
    expect(cookPhase('generating', 'Carbon is fetching the task files…')).toBe('Fetching files');
    expect(cookPhase('generating', 'Argon is reading the task…')).toBe('Planning');
    expect(cookPhase('queued', 'Carbon is queued for deliverables (1 pdf) — weight 15')).toBe('Waiting in queue');
    expect(cookPhase('generating', 'Carbon is writing the deliverables…')).toBe('Writing files');
  });
});

describe('sortOperatorCooks', () => {
  it('keeps active cooks in created order when updated_at moves', () => {
    const older: OperatorCookRow = {
      id: 'run_aaaa',
      sessionId: 'sess_a',
      status: 'generating',
      line: 'Argon is writing the deliverables…',
      phase: 'Writing files',
      createdAt: '2026-11-16T13:00:00.000Z',
      updatedAt: '2026-11-16T13:10:00.000Z',
      prompt: 'Older',
      brain: 'Argon',
      active: true,
    };
    const newer: OperatorCookRow = {
      id: 'run_bbbb',
      sessionId: 'sess_b',
      status: 'generating',
      line: 'Carbon is reading the task…',
      phase: 'Planning',
      createdAt: '2026-11-16T13:05:00.000Z',
      updatedAt: '2026-11-16T13:11:00.000Z',
      prompt: 'Newer',
      brain: 'Carbon',
      active: true,
    };
    expect(sortOperatorCooks([newer, older]).map((row) => row.id)).toEqual(['run_aaaa', 'run_bbbb']);
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

describe('ingestFilePlan', () => {
  it('adds the file a short upload missed and drops a second copy of one that landed twice', () => {
    const plan = ingestFilePlan(
      [
        { id: 'a', name: 'Deck.pptx' },
        { id: 'b', name: 'Deck.pptx' },
        { id: 'c', name: 'Notes.pdf' },
      ],
      ['Deck.pptx', 'Notes.pdf', 'Hero.png'],
      true,
    );
    expect(plan.removeIds).toEqual(['b']);
    expect(plan.add).toEqual(['Hero.png']);
  });

  it('replaces the task outputs when the cook is a new run', () => {
    const plan = ingestFilePlan([{ id: 'a', name: 'Old.pdf' }], ['Hero.png'], false);
    expect(plan.removeIds).toEqual(['a']);
    expect(plan.add).toEqual(['Hero.png']);
  });

  it('drops every extra copy once the same cook is uploaded again', () => {
    const existing = [
      { id: '1', name: 'Deck.pptx' },
      { id: '2', name: 'Deck.pptx' },
      { id: '3', name: 'Deck.pptx' },
      { id: '4', name: 'Notes.pdf' },
      { id: '5', name: 'Notes.pdf' },
      { id: '6', name: 'Hero.png' },
      { id: '7', name: 'Hero.png' },
      { id: '8', name: 'Hero.png' },
      { id: '9', name: 'Hero.png' },
      { id: '10', name: 'Hero.png' },
      { id: '11', name: 'Hero.png' },
      { id: '12', name: 'Hero.png' },
    ];
    const plan = ingestFilePlan(existing, ['Deck.pptx', 'Notes.pdf', 'Hero.png'], true);
    expect(plan.add).toEqual([]);
    expect(plan.removeIds).toEqual(['2', '3', '5', '7', '8', '9', '10', '11', '12']);
  });

  it('leaves a stored file alone when a later list is missing it', () => {
    const plan = ingestFilePlan(
      [
        { id: 'a', name: 'Deck.pptx' },
        { id: 'b', name: 'Hero.png' },
      ],
      ['Deck.pptx'],
      true,
    );
    expect(plan.removeIds).toEqual([]);
    expect(plan.add).toEqual([]);
  });
});

describe('mediaPathFromAbs', () => {
  it('turns an Autocook absolute deliverable path into a runs/ relative media path', () => {
    expect(mediaPathFromAbs('/app/runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('C:\\data\\runs\\run_abc\\final.png')).toBe('runs/run_abc/final.png');
  });
});
