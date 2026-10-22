import { describe, expect, it } from 'vitest';
import { guardLock, lockNote, packTighten, projectPicked, retireSlots, screenDrafts, swapUpserts, tightenNeed, tightenReportOf, type LockDraft, type TightenSeat, type VerifiedLock } from '@/domain/tighten';

const SOURCES = [
  'Iconography: the three supplied pillar icons and their usage rules.',
  'On Arborlane Forest, Arborlane Ink, or photographic backgrounds, an icon is placed on a White or Arborlane Stone circle.',
  'Every page in 16:9 landscape format, 13.333 x 7.5 inches.',
  'Do not crop through faces or heads.',
].join('\n');

function seat(id: string, partial: Partial<TightenSeat> = {}): TightenSeat {
  return { id, statement: `The guide states requirement ${id}.`, tag: 'Content - Semantics', family: 'content', golden: true, ai: [true, true, true], ...partial };
}

const word = (n: number) => `q${'abcdefghijklmnopqrstuvwxyz'[n % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(n / 26) % 26]}x`;

function rubric(aiYes: number, total = 50): TightenSeat[] {
  return Array.from({ length: total }, (_, i) => {
    const family = i < 5 ? 'format' : i < 20 ? 'content' : 'visual';
    const tag = family === 'format' ? 'Format/File' : family === 'content' ? 'Content - Semantics' : 'Craft - Branding';
    return seat(`s${i + 1}`, { family, tag, statement: `Check ${word(i)} ${word(i + 60)} ${word(i + 120)}.`, ai: i < aiYes ? [true, true, true] : [false, false, false] });
  });
}

const draft = (partial: Partial<LockDraft> = {}): LockDraft => ({
  statement: 'The guide states that on Arborlane Forest, Arborlane Ink, or photographic backgrounds, a pillar icon is placed on a White or Arborlane Stone circle.',
  tag: 'Content - Semantics',
  sourceLabel: 'Campaign Identity Decision Sheet',
  quote: 'an icon is placed on a White or Arborlane Stone circle',
  basis: 'verbatim',
  rationale: 'The input sets this placement rule for dark and photographic backgrounds.',
  ...partial,
});

describe('tightenNeed', () => {
  it('counts how many AI passes must flip to land every pass at the target', () => {
    const seats = rubric(42);
    seats[0]!.ai = [true, false, true];
    const need = tightenNeed(seats, 46);
    expect(need.scores).toEqual([84, 82, 84]);
    expect(need.flips).toBe(19);
  });

  it('needs nothing when every pass is already at or under the target', () => {
    expect(tightenNeed(rubric(20), 46).flips).toBe(0);
  });
});

describe('retireSlots', () => {
  it('retires seats false on the golden first, then duplicates, then seats both files pass, and never a seat the AI fails', () => {
    const seats = [
      seat('fails-ai', { ai: [false, false, false], statement: 'The guide shows a clear space diagram with 0.5X markings.' }),
      seat('passes', { statement: 'The guide states the four Inter weights and their roles.' }),
      seat('dup-a', { statement: 'The delivered brand guide PDF contains between 16 and 20 pages inclusive.', family: 'format', tag: 'Format/File' }),
      seat('dup-b', { statement: 'The delivered brand guide PDF contains between 16 and 20 pages.', family: 'format', tag: 'Format/File' }),
      seat('false', { golden: false, statement: 'The guide lists #1A3C34 for Arborlane Forest.' }),
    ];
    const order = retireSlots(seats).map((slot) => [slot.seat.id, slot.reason]);
    expect(order[0]).toEqual(['false', 'false_on_golden']);
    expect(order[1]?.[1]).toBe('duplicate');
    expect(order.map(([id]) => id)).toContain('passes');
    expect(order.map(([id]) => id)).not.toContain('fails-ai');
    expect(order.filter(([, reason]) => reason === 'duplicate')).toHaveLength(1);
  });

  it('retires seats that flip between passes before steady passes, and format seats last', () => {
    const seats = [
      seat('format', { family: 'format', tag: 'Format/File', statement: 'The delivered PDF is a single file.' }),
      seat('steady', { statement: 'The guide states the core message exactly.' }),
      seat('flip', { ai: [true, false, true], statement: 'The guide shows every lockup on an approved background.' }),
    ];
    expect(retireSlots(seats).map((slot) => slot.seat.id)).toEqual(['flip', 'steady', 'format']);
  });

  it('keeps core seats the golden passes, but still retires a core seat the golden fails', () => {
    const seats = [
      seat('core', { core: true, statement: 'Every corporate color is listed with its exact approved HEX value.' }),
      seat('core-flip', { core: true, ai: [true, false, true], statement: 'The guide states the core message exactly.' }),
      seat('core-false', { core: true, golden: false, statement: 'The guide lists #1A3C34 for Arborlane Forest.' }),
      seat('plain', { statement: 'The delivered PDF is a single file.' }),
    ];
    expect(retireSlots(seats).map((slot) => slot.seat.id)).toEqual(['core-false', 'plain']);
  });

  it('retires the non-core seat of a duplicate pair', () => {
    const seats = [
      seat('core', { core: true, statement: 'The delivered brand guide PDF contains between 16 and 20 pages inclusive.' }),
      seat('copy', { statement: 'The delivered brand guide PDF contains between 16 and 20 pages.' }),
    ];
    expect(retireSlots(seats)[0]).toMatchObject({ seat: { id: 'copy' }, reason: 'duplicate' });
  });
});

describe('guardLock', () => {
  const ctx = { sources: SOURCES, kept: ['The guide includes a visual incorrect use example for color.'], style: 'craft' as const };

  it('accepts a grounded lock whose source line exists in the task', () => {
    expect(guardLock(draft(), ctx)).toEqual([]);
  });

  it('accepts an interpretation when the cited line exists, even if the statement words it differently', () => {
    const reasons = guardLock(
      draft({
        statement: 'The guide gives the pillar icons their own section that sets out how the icons are used.',
        tag: 'Content - Structural',
        quote: 'Iconography: the three supplied pillar icons and their usage rules',
        basis: 'interpretation',
      }),
      ctx,
    );
    expect(reasons).toEqual([]);
  });

  it('matches the cited line across case, punctuation and line breaks', () => {
    expect(guardLock(draft({ quote: 'On Arborlane Forest, Arborlane Ink,\nor photographic backgrounds — an icon is placed' }), ctx)).toEqual([]);
  });

  it('rejects a cited line that is not in the brief, acceptance criteria or inputs', () => {
    expect(guardLock(draft({ quote: 'icons always sit on an amber square' }), ctx).join(' ')).toMatch(/source/i);
  });

  it('rejects quoted wording, hex values and numbers the sources do not contain', () => {
    expect(guardLock(draft({ statement: 'The guide labels the pillar row "Pillar Ochre".' }), ctx).join(' ')).toMatch(/quoted/i);
    expect(guardLock(draft({ statement: 'The guide lists Arborlane Forest as #1A3C34.' }), ctx).join(' ')).toMatch(/#1a3c34/i);
    expect(guardLock(draft({ statement: 'The guide places every pillar icon on a circle at least 48 px wide.' }), ctx).join(' ')).toMatch(/48/);
    expect(guardLock(draft({ statement: 'Every page of the guide measures 13.333 x 7.5 inches in 16:9 landscape.', tag: 'Format/File', quote: '13.333 x 7.5 inches' }), ctx)).toEqual([]);
  });

  it('rejects page references, file names, and near-duplicates of kept seats', () => {
    expect(guardLock(draft({ statement: 'Page 12 of the guide shows the icons on a White or Arborlane Stone circle.' }), ctx).join(' ')).toMatch(/page/i);
    expect(guardLock(draft({ statement: 'Unlike the golden guide, the icons sit on a White or Arborlane Stone circle on dark backgrounds.' }), ctx).join(' ')).toMatch(/golden|file/i);
    expect(guardLock(draft({ statement: 'The guide includes a visual incorrect use example for color.', tag: 'Craft - Clarity', quote: 'Iconography: the three supplied pillar icons' }), ctx).join(' ')).toMatch(/duplicate/i);
  });

  it('rejects a tag outside the rubric tag style', () => {
    expect(guardLock(draft({ tag: 'Visual - Branding' }), ctx).join(' ')).toMatch(/tag/i);
  });
});

const lock = (id: string, tag: string, ai: (boolean | null)[] = [false, false, false], golden: boolean | null = true): VerifiedLock => ({
  ...draft({ statement: `Lock ${id} statement about a distinct rule.`, tag }),
  id,
  golden,
  ai,
  goldenEvidence: 'Shown.',
  aiEvidence: ['Missing.', 'Missing.', 'Missing.'],
});

describe('packTighten', () => {

  it('swaps only locks the golden passes and the AI fails on every pass, until every pass reaches the target', () => {
    const seats = rubric(26);
    const locks = [
      lock('golden-fails', 'Content - Semantics', [false, false, false], false),
      lock('ai-flips', 'Content - Semantics', [false, true, false]),
      lock('c1', 'Content - Semantics'),
      lock('c2', 'Content - Semantics'),
      lock('k1', 'Craft - Branding'),
      lock('k2', 'Craft - Branding'),
    ];
    const result = packTighten({ seats, locks, style: 'craft', target: 46 });
    expect(result.before).toEqual([52, 52, 52]);
    expect(result.swaps.map((swap) => swap.lock.id).sort()).toEqual(['c1', 'c2', 'k1'].sort());
    expect(result.projected).toEqual([46, 46, 46]);
    expect(result.reached).toBe(true);
    expect(result.rejected.map((row) => row.id).sort()).toEqual(['ai-flips', 'golden-fails']);
    for (const swap of result.swaps) expect(swap.lock.tag.startsWith(swap.seatFamily === 'content' ? 'Content' : 'Craft')).toBe(true);
  });

  it('crosses families only within the quota tolerance', () => {
    const seats = rubric(30);
    const locks = ['a', 'b', 'c', 'd', 'e'].map((id) => lock(id, 'Craft - Branding'));
    seats.forEach((row) => {
      if (row.family === 'visual') row.ai = [false, false, false];
    });
    const result = packTighten({ seats, locks, style: 'craft', target: 0 });
    expect(result.swaps).toHaveLength(2);
    expect(result.quotaReady).toBe(true);
  });

  it('still replaces seats the golden fails after the target is reached', () => {
    const seats = rubric(20);
    seats[30]!.golden = false;
    const result = packTighten({ seats, locks: [lock('k1', 'Craft - Branding')], style: 'craft', target: 46 });
    expect(result.swaps.map((swap) => [swap.seatId, swap.reason])).toEqual([['s31', 'false_on_golden']]);
    expect(result.reached).toBe(true);
  });

  it('reports a shortfall instead of padding when verified locks run out', () => {
    const result = packTighten({ seats: rubric(40), locks: [lock('c1', 'Content - Semantics')], style: 'craft', target: 46 });
    expect(result.reached).toBe(false);
    expect(result.projected).toEqual([78, 78, 78]);
    expect(result.shortBy).toBe(16);
  });
});

describe('tightenReportOf / lockNote', () => {
  it('ignores results stored by the old helper', () => {
    expect(tightenReportOf({ keep: [], act: [], add: [], mix: {} })).toBeNull();
    expect(tightenReportOf({ swaps: [], before: [80], projected: [80], rubricRevision: 3 })?.rubricRevision).toBe(3);
  });

  it('cites the source line and fits the 600-character notes limit', () => {
    expect(lockNote(draft())).toBe('Source (Campaign Identity Decision Sheet): "an icon is placed on a White or Arborlane Stone circle". The input sets this placement rule for dark and photographic backgrounds.');
    expect(lockNote(draft({ basis: 'interpretation', rationale: 'x'.repeat(700) }))).toHaveLength(600);
  });
});

describe('projectPicked / swapUpserts', () => {
  const report = () => packTighten({ seats: rubric(26), locks: [lock('c1', 'Content - Semantics'), lock('c2', 'Content - Semantics'), lock('k1', 'Craft - Branding')], style: 'craft', target: 46 });

  it('projects the AI score from only the ticked swaps', () => {
    const result = report();
    expect(projectPicked(result, new Set())).toEqual([52, 52, 52]);
    expect(projectPicked(result, new Set([result.swaps[0]!.seatId]))).toEqual([50, 50, 50]);
    expect(projectPicked(result, new Set(result.swaps.map((swap) => swap.seatId)))).toEqual(result.projected);
  });

  it('writes the lock onto the retired seat and skips seats edited since', () => {
    const result = report();
    const [first, second] = result.swaps;
    const current = rubric(26).map((row) => (row.id === second!.seatId ? { ...row, statement: 'Edited by hand since.' } : row));
    const { upserts, stale } = swapUpserts(result.swaps, new Set([first!.seatId, second!.seatId]), current);
    expect(stale).toEqual([second!.seatId]);
    expect(upserts).toEqual([{ id: first!.seatId, tag: first!.lock.tag, statement: first!.lock.statement, notes: lockNote(first!.lock), scope: 'output', inputFileIds: [], outputFile: null }]);
  });
});

describe('screenDrafts', () => {
  const drafts = ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => ({ ...draft({ statement: `Draft ${id} statement.` }), id }));

  it('drops compound drafts and drafts that repeat a seat or an earlier draft, keeping the first of a pair', () => {
    const { keep, dropped } = screenDrafts(drafts, {
      compound: ['d2'],
      same: [
        { id: 'd3', as: 's7' },
        { id: 'd5', as: 'd4' },
        { id: 'd1', as: 'd4' },
      ],
    }, new Set(['s7']));
    expect(keep.map((row) => row.id)).toEqual(['d1']);
    expect(dropped.map((row) => [row.statement, row.reasons[0]])).toEqual([
      ['Draft d2 statement.', 'Checks two separate things; one could pass while the other fails.'],
      ['Draft d3 statement.', 'Checks the same requirement as a seat already in the rubric.'],
      ['Draft d4 statement.', 'Checks the same requirement as another lock.'],
      ['Draft d5 statement.', 'Checks the same requirement as another lock.'],
    ]);
  });

  it('drops drafts that describe a flaw in the AI output instead of a stated requirement', () => {
    const { keep, dropped } = screenDrafts(drafts.slice(0, 2), { compound: [], same: [], fitted: ['d2'] }, new Set());
    expect(keep.map((row) => row.id)).toEqual(['d1']);
    expect(dropped).toEqual([{ statement: 'Draft d2 statement.', reasons: ['Describes a flaw in this AI output, not a requirement the task states.'] }]);
  });

  it('ignores ids the review made up', () => {
    const { keep } = screenDrafts(drafts.slice(0, 2), { compound: ['x9'], same: [{ id: 'd1', as: 'zz' }] }, new Set());
    expect(keep.map((row) => row.id)).toEqual(['d1', 'd2']);
  });
});
