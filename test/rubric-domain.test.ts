import { describe, expect, it } from 'vitest';
import { assemble, type BankRow } from '@/domain/assemble';
import { fingerprint, sourceFingerprint, statementHash, stripVolatileUrl } from '@/domain/fingerprint';
import { compactBankRow, parseBank, rewriteBank } from '@/domain/bank';
import { formatDate } from '@/components/format';
import { lintStatement, looksLikeInterrogative, nearDuplicate, toAffirmativeStatement, tokenJaccard } from '@/domain/lint';
import { analyzeDiscrimination, isSoftSeat } from '@/domain/discrimination';
import { familyOfTag, familyQuotas, RUBRIC_TAGS, seatIndexById, seatLabel, seatsInDisplayOrder, withSeatLabels, type Family } from '@/domain/rubric';
import { normalisedWeights, scoreSeats } from '@/domain/weights';

describe('formatDate', () => {
  it('is identical on every runtime (no locale spaces)', () => {
    expect(formatDate('2026-10-10T02:00:00.000Z')).toBe('2026-10-10 02:00 UTC');
    expect(formatDate('2026-10-10 02:00:00')).toBe('2026-10-10 02:00 UTC');
    expect(formatDate(null)).toBe('—');
  });
});

describe('lint', () => {
  it('passes a well-formed affirmative statement', () => {
    const r = lintStatement({ statement: 'The title slide shows the client logo in the top-left corner.', tag: 'Visual - Branding' });
    expect(r.overall).toBe('pass');
    expect(r.reasons).toEqual([]);
  });

  it('rejects questions, time-bound words, stacked claims, defect-as-desired, unknown tags', () => {
    expect(lintStatement({ statement: 'Does the slide show the logo?', tag: 'Visual - Branding' }).verdicts.unambiguous).toBe('fail');
    expect(lintStatement({ statement: 'The deck cites the latest figures.', tag: 'Content - Exact' }).verdicts.timeless).toBe('fail');
    expect(lintStatement({ statement: 'The chart has a legend and also the axis is labelled.', tag: 'Content - Structural' }).verdicts.non_stacked).toBe('fail');
    expect(lintStatement({ statement: 'The slide contains visible clutter.', tag: 'Visual - Balance/Density' }).verdicts.expected_yes).toBe('fail');
    expect(lintStatement({ statement: 'The slide is free of clutter.', tag: 'Visual - Balance/Density' }).verdicts.expected_yes).toBe('pass');
    expect(lintStatement({ statement: 'The file opens.', tag: 'Nope' }).reasons.join()).toMatch(/unknown tag/);
  });

  it('converts pasted questions into statements', () => {
    expect(looksLikeInterrogative('Is the logo visible?')).toBe(true);
    expect(toAffirmativeStatement('Is the logo visible?')).toBe('The logo visible.');
    expect(toAffirmativeStatement('the deck has twelve slides')).toBe('The deck has twelve slides.');
  });

  it('detects paraphrases with Jaccard ≥ 0.72', () => {
    expect(nearDuplicate('The title slide shows the client logo top-left.', 'The title slide shows the client logo top-left corner.')).toBe(true);
    expect(nearDuplicate('The title slide shows the client logo.', 'Every chart has a labelled axis.')).toBe(false);
    expect(tokenJaccard('The title slide shows the client logo.', 'The title slide shows the client logo.')).toBe(1);
    expect(tokenJaccard('logo branding', 'axis labels')).toBe(0);
  });
});

describe('factory bank compact form', () => {
  const row = { claimKey: 'logo-lockup', statement: 'The title slide shows the client logo top-left.', tag: 'Visual - Branding', family: 'visual' as const, notes: '', seedId: 'seed-1', strength: 82 };

  it('round-trips unused bank rows and returns a displaced claim after a swap', () => {
    const generation = { bank: [compactBankRow(row), compactBankRow({ ...row, claimKey: 'axis-label', statement: 'Every chart has a labelled axis.', strength: 70 })], model: 'x' };
    expect(parseBank(generation)).toHaveLength(2);
    const next = rewriteBank(generation, row, { claimKey: 'old-seat', statement: 'The footer shows the page number.', tag: 'Format/File', family: 'format', notes: '', seedId: '' });
    const bank = parseBank(next);
    expect(bank.map((c) => c.claimKey)).toEqual(['old-seat', 'axis-label']);
    expect(next.model).toBe('x');
  });
});

describe('rubric tags and quotas', () => {
  it('maps every tag to a family', () => {
    for (const tag of RUBRIC_TAGS) expect(['format', 'content', 'visual']).toContain(familyOfTag(tag));
    expect(familyOfTag('garbage')).toBe('content');
  });
  it('splits 50 as 5/15/30 and sums to the target', () => {
    expect(familyQuotas(50)).toEqual({ format: 5, content: 15, visual: 30 });
    for (const n of [40, 47, 60]) {
      const q = familyQuotas(n);
      expect(q.format + q.content + q.visual).toBe(n);
    }
  });
});

describe('global seats', () => {
  it('numbers Format then Content then Visual so seat 8 is unique', () => {
    const rows = [
      { id: 'v1', family: 'visual' as const, position: 1 },
      { id: 'c1', family: 'content' as const, position: 2 },
      { id: 'f1', family: 'format' as const, position: 3 },
      { id: 'c2', family: 'content' as const, position: 4 },
    ];
    expect(seatsInDisplayOrder(rows).map((r) => r.id)).toEqual(['f1', 'c1', 'c2', 'v1']);
    const seats = seatIndexById(rows);
    expect(seats.get('f1')).toBe(1);
    expect(seats.get('c1')).toBe(2);
    expect(seats.get('c2')).toBe(3);
    expect(seats.get('v1')).toBe(4);
    expect(seatLabel(8)).toBe('Seat 8');
    expect(withSeatLabels('autorate failed for v1 / s004', seats)).toBe('autorate failed for Seat 4 / Seat 4');
  });
});

describe('discrimination', () => {
  it('flags low-strength and taste wording as soft', () => {
    expect(isSoftSeat({ statement: 'The title is present.', strength: 20 })).toBe(true);
    expect(isSoftSeat({ statement: 'The slide looks professional.' })).toBe(true);
    expect(isSoftSeat({ statement: 'The footer is free of overlapping text.', strength: 80 })).toBe(false);
  });

  it('suggests a harder unused bank claim for a soft seat', () => {
    const report = analyzeDiscrimination(
      [{ claimKey: 'title-soft', statement: 'The title is present.', family: 'content', strength: 15 }],
      [
        { claimKey: 'title-hard', statement: 'The title contains exactly three words.', family: 'content', strength: 90 },
        { claimKey: 'other', statement: 'The logo hex is #6375ff.', family: 'visual', strength: 88 },
      ],
    );
    expect(report.softCount).toBe(1);
    expect(report.hints[0]?.replacement?.claimKey).toBe('title-hard');
  });
});

describe('assemble', () => {
  // Unique vocabulary per row keeps Jaccard low so only the explicit duplicate collapses.
  const row = (seedId: string, i: number, family: Family, tag: string, statement?: string): BankRow => ({
    seedId,
    claimKey: `${seedId}-${family}-${i}`,
    statement: statement ?? `The ${seedId}${family}${i}alpha ${seedId}${family}${i}beta ${seedId}${family}${i}gamma is present.`,
    tag,
    family,
    notes: '',
  });

  it('drops lint failures and duplicates, then fills quotas round-robin across seeds', () => {
    const bank: BankRow[] = [];
    for (const seed of ['s1', 's2', 's3']) {
      for (let i = 0; i < 6; i++) bank.push(row(seed, i, 'visual', 'Visual - Layout'));
      for (let i = 0; i < 4; i++) bank.push(row(seed, i, 'content', 'Content - Exact'));
      for (let i = 0; i < 2; i++) bank.push(row(seed, i, 'format', 'Format/File'));
    }
    bank.push(row('s1', 99, 'visual', 'Visual - Layout', 'Does the slide show the logo?'));
    bank.push({ ...row('s1', 0, 'visual', 'Visual - Layout'), claimKey: 'dup-key' }); // same wording → near-dup

    const result = assemble(bank, { format: 2, content: 6, visual: 9 });
    expect(result.droppedByLint).toBe(1);
    expect(result.droppedAsDuplicate).toBe(1);
    expect(result.seated).toHaveLength(17);
    const visual = result.seated.filter((r) => r.family === 'visual');
    const bySeed = new Map<string, number>();
    for (const r of visual) bySeed.set(r.seedId, (bySeed.get(r.seedId) ?? 0) + 1);
    expect([...bySeed.values()]).toEqual([3, 3, 3]);
  });

  it('redistributes seats a family cannot fill', () => {
    const bank: BankRow[] = [];
    for (let i = 0; i < 10; i++) bank.push(row('s1', i, 'content', 'Content - Exact'));
    const result = assemble(bank, { format: 2, content: 3, visual: 5 });
    expect(result.seated).toHaveLength(10);
  });

  it('seats the strongest row from a seed when the family has one seat', () => {
    const weak = { ...row('s1', 1, 'visual', 'Visual - Layout'), strength: 20 };
    const strong = { ...row('s1', 2, 'visual', 'Visual - Layout'), strength: 92 };
    const result = assemble([weak, strong], { format: 0, content: 0, visual: 1 });
    expect(result.seated).toHaveLength(1);
    expect(result.seated[0]?.claimKey).toBe(strong.claimKey);
  });
});

describe('seat weights', () => {
  it('splits equal shares that sum to 100 and leaves unanswered out of the live score', () => {
    expect(normalisedWeights([{}, {}, {}])).toEqual([33.33, 33.33, 33.34]);
    const score = scoreSeats([{ answer: true }, { answer: false }, { answer: null }]);
    expect(score.passed).toBe(1);
    expect(score.graded).toBe(2);
    expect(score.outstanding).toBe(1);
    expect(score.fraction).toBeCloseTo(0.5, 5);
    expect(score.floor).toBeCloseTo(0.3333, 3);
    expect(score.ceiling).toBeCloseTo(0.6667, 3);
  });
});

describe('fingerprint', () => {
  it('is key-order independent and strips presigned query parameters', () => {
    expect(fingerprint({ a: 1, b: [1, 2] })).toBe(fingerprint({ b: [1, 2], a: 1 }));
    const a = 'https://bucket.s3.amazonaws.com/golden.pptx?X-Amz-Date=1&X-Amz-Signature=abc&X-Amz-Expires=300&v=2';
    const b = 'https://bucket.s3.amazonaws.com/golden.pptx?X-Amz-Date=2&X-Amz-Signature=def&X-Amz-Expires=300&v=2';
    expect(stripVolatileUrl(a)).toBe(stripVolatileUrl(b));
    expect(sourceFingerprint({ files: [a] })).toBe(sourceFingerprint({ files: [b] }));
    expect(sourceFingerprint({ files: [a] })).not.toBe(sourceFingerprint({ files: [a.replace('golden', 'golden2')] }));
  });

  it('statementHash binds wording and scope only', () => {
    const base = { statement: 'The logo is visible.', scope: 'output' as const, inputFileIds: ['b', 'a'], outputFile: null };
    expect(statementHash(base)).toBe(statementHash({ ...base, inputFileIds: ['a', 'b'], statement: ' The logo is visible. ' }));
    expect(statementHash(base)).not.toBe(statementHash({ ...base, outputFile: 'deck.pptx' }));
    expect(statementHash(base)).not.toBe(statementHash({ ...base, scope: 'inputs' }));
  });
});
