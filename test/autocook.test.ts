import { describe, expect, it } from 'vitest';
import {
  AUTOCOOK_OPERATOR_EMAIL,
  applyCookActivity,
  brainFromModelTag,
  canAutocookEmail,
  closeBlocksCookWatch,
  cookPhase,
  cookPromptFromFields,
  ingestFilePlan,
  mediaPathFromAbs,
  cookListUnchanged,
  operatorCookFromRun,
  sortOperatorCooks,
  type OperatorCookRow,
} from '@/domain/autocook';

function cook(partial: Partial<OperatorCookRow> & Pick<OperatorCookRow, 'id' | 'active'>): OperatorCookRow {
  return {
    sessionId: `sess_${partial.id}`,
    status: partial.active ? 'generating' : 'exported',
    line: partial.active ? 'Argon is writing the deliverables…' : 'Exported',
    phase: partial.active ? 'Writing files' : 'Done',
    createdAt: '2026-11-16T13:00:00.000Z',
    updatedAt: '2026-11-16T13:00:00.000Z',
    activityAt: '2026-11-16T13:00:00.000Z',
    prompt: 'Task',
    brain: 'Argon',
    ...partial,
  };
}

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
    expect(row?.activityAt).toBe('2026-11-16T11:00:00.000Z');
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
    const older = cook({
      id: 'run_aaaa',
      active: true,
      createdAt: '2026-11-16T13:00:00.000Z',
      updatedAt: '2026-11-16T13:10:00.000Z',
      activityAt: '2026-11-16T13:00:00.000Z',
    });
    const newer = cook({
      id: 'run_bbbb',
      active: true,
      brain: 'Carbon',
      createdAt: '2026-11-16T13:05:00.000Z',
      updatedAt: '2026-11-16T13:11:00.000Z',
      activityAt: '2026-11-16T13:05:00.000Z',
    });
    expect(sortOperatorCooks([newer, older]).map((row) => row.id)).toEqual(['run_aaaa', 'run_bbbb']);
  });

  it('does not reshuffle finished cooks when Autocook updated_at heartbeats', () => {
    const landedFirst = cook({
      id: 'run_old',
      active: false,
      createdAt: '2026-11-16T12:00:00.000Z',
      activityAt: '2026-11-16T12:30:00.000Z',
      updatedAt: '2026-11-16T14:00:02.000Z',
    });
    const landedLater = cook({
      id: 'run_new',
      active: false,
      createdAt: '2026-11-16T12:10:00.000Z',
      activityAt: '2026-11-16T12:40:00.000Z',
      updatedAt: '2026-11-16T14:00:01.000Z',
    });
    expect(sortOperatorCooks([landedFirst, landedLater]).map((row) => row.id)).toEqual(['run_new', 'run_old']);
  });
});

describe('cookListUnchanged', () => {
  it('treats an Autocook updated_at heartbeat as no panel change', () => {
    const before = cook({ id: 'run_same', active: false, updatedAt: '2026-11-16T12:00:00.000Z' });
    const after = cook({ id: 'run_same', active: false, updatedAt: '2026-11-16T14:00:00.000Z' });
    expect(cookListUnchanged([before], [after])).toBe(true);
  });
});

describe('applyCookActivity', () => {
  it('uses land/close time for finished cooks and ignores open/heartbeat updated_at', () => {
    const finished = cook({
      id: 'run_landed',
      active: false,
      createdAt: '2026-11-16T12:00:00.000Z',
      updatedAt: '2026-11-16T14:00:00.000Z',
    });
    const stillCooking = cook({
      id: 'run_live',
      active: true,
      createdAt: '2026-11-16T12:05:00.000Z',
      updatedAt: '2026-11-16T14:00:00.000Z',
    });
    const next = applyCookActivity([finished, stillCooking], [
      { runId: 'run_landed', action: 'autocook_ingested', createdAt: '2026-11-16T12:40:00.000Z' },
      { runId: 'run_live', action: 'autocook_ingested', createdAt: '2026-11-16T12:50:00.000Z' },
    ]);
    expect(next.find((row) => row.id === 'run_landed')?.activityAt).toBe('2026-11-16T12:40:00.000Z');
    expect(next.find((row) => row.id === 'run_live')?.activityAt).toBe('2026-11-16T12:05:00.000Z');
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

  it('does not put back a cook file the operator removed after that run landed', () => {
    const plan = ingestFilePlan([], ['Hero.png'], true, ['Hero.png']);
    expect(plan.add).toEqual([]);
    expect(plan.removeIds).toEqual([]);
  });

  it('does not append the cook file next to a replacement the operator uploaded', () => {
    const plan = ingestFilePlan([{ id: 'x', name: 'mine.html' }], ['cook.html'], true, ['cook.html']);
    expect(plan.add).toEqual([]);
    expect(plan.removeIds).toEqual([]);
  });

  it('still adds a name the first ingest never landed', () => {
    const plan = ingestFilePlan([{ id: 'a', name: 'Deck.pptx' }], ['Deck.pptx', 'Hero.png'], true, ['Deck.pptx']);
    expect(plan.add).toEqual(['Hero.png']);
    expect(plan.removeIds).toEqual([]);
  });
});

describe('closeBlocksCookWatch', () => {
  it('lets a retried cook be watched after a failed close', () => {
    expect(closeBlocksCookWatch(null, 'run_abc')).toBe(false);
    expect(closeBlocksCookWatch({ runId: 'run_other', status: 'failed' }, 'run_abc')).toBe(false);
    expect(closeBlocksCookWatch({ runId: 'run_abc', status: 'failed' }, 'run_abc')).toBe(false);
    expect(closeBlocksCookWatch({ runId: 'run_abc', status: 'rejected' }, 'run_abc')).toBe(false);
  });

  it('leaves the watch list once the cook is exported, and when an older close has no status', () => {
    expect(closeBlocksCookWatch({ runId: 'run_abc', status: 'exported' }, 'run_abc')).toBe(true);
    expect(closeBlocksCookWatch({ runId: 'run_abc', status: null }, 'run_abc')).toBe(true);
    expect(closeBlocksCookWatch({ runId: 'run_abc' }, 'run_abc')).toBe(true);
  });
});

describe('mediaPathFromAbs', () => {
  it('turns an Autocook absolute deliverable path into a runs/ relative media path', () => {
    expect(mediaPathFromAbs('/app/runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('runs/run_abc/out/final.pptx')).toBe('runs/run_abc/out/final.pptx');
    expect(mediaPathFromAbs('C:\\data\\runs\\run_abc\\final.png')).toBe('runs/run_abc/final.png');
  });
});
