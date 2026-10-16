import { describe, expect, it } from 'vitest';
import { analyzeHelperSeats, applyFittedScan, helperConfidence, helperGate, looksCheated, packHelperResult, promptFromFields, seatGroundingOf, type HelperDraft, type HelperSeatInput } from '@/domain/helper';

const CANVAS =
  'Every text box, chart, shape, and image across all slides in the delivered presentation is positioned entirely within the 16:9 slide canvas boundaries.';
const TITLE = 'The title names the client.';
const NARRATION = 'The spoken narration states that Westbridge is introducing a new employee access card.';
const PROMPT = 'Deliver a 16:9 staff deck. The spoken narration states that Westbridge is introducing a new employee access card.';

function seat(partial: Partial<HelperSeatInput> & Pick<HelperSeatInput, 'id'>): HelperSeatInput {
  return {
    statement: CANVAS,
    tag: 'Visual - Layout',
    family: 'visual',
    golden: true,
    stability: [true, true, true],
    ...partial,
  };
}

describe('helperGate', () => {
  it('names what is missing before a run can start', () => {
    expect(helperGate({ hasRubric: false, goldenGraded: 0, stabilityPasses: 0, hasAi: false, hasPrompt: false }).ok).toBe(false);
    expect(helperGate({ hasRubric: true, goldenGraded: 50, stabilityPasses: 3, hasAi: true, hasPrompt: true })).toEqual({
      ok: true,
      missing: [],
    });
    expect(
      helperGate({ hasRubric: true, goldenGraded: 0, stabilityPasses: 3, hasAi: true, hasPrompt: true }).missing,
    ).toContain('Grade the golden file first.');
  });

  it('reads the Catalog task field as the prompt', () => {
    expect(
      promptFromFields([
        { key: 'title', text: 'Slides with moodboards' },
        { key: 'task', text: 'Propose two visual directions for Velvet Bean Coffee Co.' },
        { key: 'acceptanceCriteria', text: 'The presentation includes a cover page.' },
      ]),
    ).toBe('Propose two visual directions for Velvet Bean Coffee Co.');
  });
});

describe('analyzeHelperSeats', () => {
  it('classifies from Golden and this AI pack, not from Stability spread', () => {
    const rows = analyzeHelperSeats(
      [
        seat({ id: 'keep', statement: NARRATION, tag: 'Content - Semantics', family: 'content', stability: [true, false, true] }),
        seat({ id: 'fitted', statement: 'The penguin mascot wears glasses on the teal card.', tag: 'Visual - Branding', family: 'visual', stability: [false, false, false] }),
        seat({ id: 'cheat', statement: 'The golden deck crops the lockup on slide 4.', tag: 'Visual - Layout', family: 'visual', stability: [false, false, false] }),
        seat({ id: 'hygiene', statement: 'The delivered presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
        seat({ id: 'noise', statement: 'Placed photographs keep print resolution.', golden: false, goldenEvidence: 'Digest flagged 96 dpi on the placed photo.' }),
        seat({ id: 'false', statement: 'The wordmark sits in the center third of the title slide.', golden: false, goldenEvidence: 'The mark is centered with empty sides, not the center third.' }),
        seat({ id: 'soft', statement: 'The deck has a professional look.' }),
        seat({ id: 'blank', golden: null, stability: [null, null, null] }),
        seat({ id: 'happen', statement: 'The bronze column motif appears on both folds.', stability: [false, false, false] }),
      ],
      { prompt: PROMPT },
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.keep?.bucket).toBe('discriminator');
    expect(byId.keep?.action).toBe('keep');
    expect(byId.hygiene?.bucket).toBe('hygiene');
    expect(byId.noise?.bucket).toBe('rater_noise');
    expect(byId.noise?.action).toBe('override');
    expect(byId.false?.bucket).toBe('false_on_golden');
    expect(byId.false?.action).toBe('rewrite');
    expect(byId.soft?.bucket).toBe('soft');
    expect(byId.blank?.bucket).toBe('ungraded');
    expect(byId.happen?.bucket).toBe('happenstance');
    expect(byId.happen?.action).toBe('drop');
    expect(byId.keep?.reason).not.toMatch(/stable|repeatability|tighten/i);
    expect(byId.fitted?.bucket).toBe('output_fitted');
    expect(byId.fitted?.action).toBe('rewrite');
    expect(byId.fitted?.reason).toMatch(/brief|input|craft/i);
    expect(byId.cheat?.bucket).toBe('output_fitted');
    expect(byId.cheat?.action).toBe('rewrite');
  });

  it('lets a second read mark a brief-sounding seat as written off the output', () => {
    const sneak = 'Westbridge staff see a teal penguin on the access card.';
    const rows = analyzeHelperSeats(
      [
        seat({ id: 'sneak', statement: sneak, tag: 'Content - Semantics', family: 'content', stability: [true, false, false] }),
        seat({ id: 'dup-a', statement: 'The delivered presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
        seat({ id: 'dup-b', statement: 'The presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
      ],
      { prompt: PROMPT },
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.sneak?.bucket).toBe('discriminator');
    expect(byId['dup-a']?.bucket).toBe('duplicate');
    const scanned = applyFittedScan(rows, ['sneak', 'dup-a']);
    const after = Object.fromEntries(scanned.map((row) => [row.id, row]));
    expect(after.sneak?.bucket).toBe('output_fitted');
    expect(after.sneak?.action).toBe('rewrite');
    expect(after['dup-a']?.bucket).toBe('duplicate');
    expect(after['dup-a']?.action).toBe('drop');
  });
});

describe('seatGroundingOf', () => {
  it('accepts the brief, a named input, or a named craft implicit — and rejects output hunting', () => {
    const grounding = { prompt: PROMPT, inputRoles: ['brand guidelines'] };
    expect(seatGroundingOf(NARRATION, grounding)).toBe('prompt');
    expect(seatGroundingOf('The delivered presentation uses a 16:9 page size.', grounding)).toBe('prompt');
    expect(seatGroundingOf('Palette tokens follow the brand guidelines.', grounding)).toBe('input:brand guidelines');
    expect(seatGroundingOf(CANVAS, grounding)).toBe('craft:slides-canvas');
    expect(seatGroundingOf('The penguin mascot wears glasses on the teal card.', grounding)).toBeNull();
    expect(seatGroundingOf('The golden video shows Darren on a brown sofa.', grounding)).toBeNull();
  });
});

describe('looksCheated', () => {
  it('drops wording that cites the Golden or AI instead of the brief', () => {
    const grounding = { prompt: PROMPT, inputRoles: ['brand guidelines'] };
    expect(looksCheated('The golden video shows Darren sitting on a brown sofa.', grounding)).toBe(true);
    expect(looksCheated('The AI output crops the logo on slide 4.', grounding)).toBe(true);
    expect(looksCheated('Use brand-guide.pdf for the palette.', grounding)).toBe(true);
    expect(looksCheated(CANVAS, grounding)).toBe(false);
  });
});

describe('packHelperResult', () => {
  it('returns Keep / Act / Add and refuses a mix that would miss Golden 100 or calibration under 40', () => {
    const seats = [
      seat({ id: 'keep', statement: NARRATION, tag: 'Content - Semantics', family: 'content', stability: [true, false, false] }),
      seat({ id: 'fitted', statement: 'The penguin mascot wears glasses on the teal card.', tag: 'Visual - Branding', family: 'visual', stability: [false, false, false] }),
      seat({ id: 'format', statement: 'The delivered presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
      seat({ id: 'hygiene' }),
      seat({ id: 'false', statement: 'The wordmark sits in the center third of the title slide.', golden: false }),
    ];
    const drafts: HelperDraft[] = [
      {
        seatId: 'fitted',
        statement: 'The spoken narration names the new employee access card.',
        tag: 'Content - Semantics',
        grounding: 'prompt',
        golden: true,
        ai: false,
      },
      {
        seatId: 'false',
        statement: 'The title-slide wordmark is centered with empty space on both sides.',
        tag: 'Visual - Layout',
        grounding: 'craft:slides-title-safe',
        golden: true,
        ai: false,
      },
      {
        seatId: 'false',
        statement: 'All on-screen graphics stay inside the 16:9 slide canvas.',
        tag: 'Visual - Layout',
        grounding: 'prompt',
        golden: true,
        ai: true,
      },
      {
        statement: 'The golden deck uses a unique bronze column motif on both folds.',
        tag: 'Visual - Layout',
        grounding: 'craft:print-fold',
      },
      {
        statement: 'The spoken line names Westbridge.',
        tag: 'Content - Exact',
        grounding: 'prompt',
        golden: true,
        ai: false,
      },
    ];
    const packed = packHelperResult({ seats, prompt: PROMPT, inputRoles: ['brand guidelines'], drafts });
    expect(packed.keep.map((row) => row.id)).toEqual(['keep', 'format']);
    expect(packed.act.map((row) => [row.id, row.action])).toEqual([
      ['fitted', 'rewrite'],
      ['false', 'rewrite'],
      ['hygiene', 'drop'],
    ]);
    expect(packed.act.find((row) => row.id === 'fitted')?.rewrite).toBe('The spoken narration names the new employee access card.');
    expect(packed.act.find((row) => row.id === 'false')?.rewrite).toBe('The title-slide wordmark is centered with empty space on both sides.');
    expect(packed.add.map((row) => row.statement)).toEqual(['The spoken line names Westbridge.']);
    expect(packed.mix.predictedGolden).toBe(100);
    expect(packed.mix.predictedCalibration).toBeLessThan(40);
    expect(packed.mix.predictedCalibration).toBeGreaterThanOrEqual(20);
    expect(packed.mix.ready).toBe(true);
    expect(packed.mix.refuse).toBeNull();
  });

  it('surfaces output-fitted and duplicate seats before the rest of Act', () => {
    const packed = packHelperResult({
      seats: [
        seat({ id: 'keep', statement: NARRATION, tag: 'Content - Semantics', family: 'content', stability: [true, false, false] }),
        seat({ id: 'sneak', statement: 'Westbridge staff see a teal penguin on the access card.', tag: 'Content - Semantics', family: 'content', stability: [true, false, false] }),
        seat({ id: 'dup-a', statement: 'The delivered presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
        seat({ id: 'dup-b', statement: 'The presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
        seat({ id: 'false', statement: 'The wordmark sits in the center third of the title slide.', golden: false }),
      ],
      prompt: PROMPT,
      inputRoles: [],
      fittedIds: ['sneak'],
      drafts: [],
    });
    expect(packed.keep.map((row) => row.id)).toEqual(['keep']);
    expect(packed.act.map((row) => [row.bucket])).toEqual([['output_fitted'], ['duplicate'], ['duplicate'], ['false_on_golden']]);
    expect(packed.act[0]?.id).toBe('sneak');
  });

  it('refuses a batch that would leave a false Golden lock in place', () => {
    const packed = packHelperResult({
      seats: [seat({ id: 'false', statement: 'The ink is bronze on every panel.', golden: false })],
      prompt: PROMPT,
      inputRoles: [],
      drafts: [],
    });
    expect(packed.mix.predictedGolden).toBeLessThan(100);
    expect(packed.mix.ready).toBe(false);
    expect(packed.mix.refuse).toMatch(/fails the golden file/i);
  });
});

describe('helperConfidence', () => {
  it('caps unknown Golden and zeros cheated wording', () => {
    expect(
      helperConfidence({
        grounding: 'prompt',
        golden: null,
        ai: false,
        lintPass: true,
        digestRatable: true,
        cheated: false,
      }),
    ).toBeLessThanOrEqual(40);
    expect(
      helperConfidence({
        grounding: 'prompt',
        golden: true,
        ai: false,
        lintPass: true,
        digestRatable: true,
        cheated: true,
      }),
    ).toBe(0);
  });
});
