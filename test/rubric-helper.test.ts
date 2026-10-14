import { describe, expect, it } from 'vitest';
import { analyzeHelperSeats, helperConfidence, helperGate, looksCheated, packHelperResult, promptFromFields, type HelperDraft, type HelperSeatInput } from '@/domain/helper';

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
        seat({ id: 'keep', statement: TITLE, tag: 'Content - Exact', family: 'content', stability: [true, false, true] }),
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
      seat({ id: 'keep', statement: TITLE, tag: 'Content - Exact', family: 'content', stability: [true, false, false] }),
      seat({ id: 'format', statement: 'The delivered presentation uses a 16:9 page size.', tag: 'Format/File', family: 'format' }),
      seat({ id: 'hygiene' }),
      seat({ id: 'false', statement: 'The wordmark sits in the center third of the title slide.', golden: false }),
    ];
    const drafts: HelperDraft[] = [
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
        statement: NARRATION,
        tag: 'Content - Semantics',
        grounding: 'prompt',
        golden: true,
        ai: false,
      },
    ];
    const packed = packHelperResult({ seats, prompt: PROMPT, inputRoles: ['brand guidelines'], drafts });
    expect(packed.keep.map((row) => row.id)).toEqual(['keep', 'format']);
    expect(packed.act.map((row) => [row.id, row.action])).toEqual([
      ['false', 'rewrite'],
      ['hygiene', 'drop'],
    ]);
    expect(packed.act[0]?.rewrite).toBe('The title-slide wordmark is centered with empty space on both sides.');
    expect(packed.add.map((row) => row.statement)).toEqual([NARRATION]);
    expect(packed.mix.predictedGolden).toBe(100);
    expect(packed.mix.predictedCalibration).toBeLessThan(40);
    expect(packed.mix.predictedCalibration).toBeGreaterThanOrEqual(20);
    expect(packed.mix.ready).toBe(true);
    expect(packed.mix.refuse).toBeNull();
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
