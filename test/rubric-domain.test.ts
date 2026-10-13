import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble, type BankRow } from '@/domain/assemble';
import { fingerprint, sourceFingerprint, statementHash, stripVolatileUrl } from '@/domain/fingerprint';
import { compactBankRow, parseBank, rewriteBank } from '@/domain/bank';
import { formatDate } from '@/components/format';
import { lintStatement, looksLikeInterrogative, nearDuplicate, toAffirmativeStatement, tokenJaccard } from '@/domain/lint';
import { analyzeDiscrimination, isSoftSeat } from '@/domain/discrimination';
import { correctTag, countFamilies, familyOfStatement, familyOfTag, familyQuotas, guessTag, quotaSpread, reseatImportedTag, reseatOverQuotaFamilies, RUBRIC_TAGS, seatedFamily, seatIndexById, seatLabel, seatsInDisplayOrder, withSeatLabels, type Family } from '@/domain/rubric';
import { catalogLooksInboundReady, submittedCatalogStatusIds } from '@/domain/catalogListState';
import { asLegacyVerdict, assignmentSeat, factoryStatementsFromLegacy, inferLegacyPipeline, latestLegacyRun, legacyStabilityHostId, mapLegacyRoles, mapLegacySeatIds, mapLegacyStage, parseLegacyRubricRows, remapVerdicts, stabilityGroupsFromAutorate } from '@/domain/legacyImport';
import { workStateOf } from '@/domain/workState';
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

  it('reads unused bank claims with descriptor language instead of name.extension', () => {
    const generation = {
      bank: [compactBankRow({ ...row, statement: 'The q3-regional-deck.pptx uses a 16:9 page size.' })],
    };
    expect(parseBank(generation)[0]?.statement).toBe('The delivered presentation uses a 16:9 page size.');
  });
});

describe('quota spread', () => {
  it('is ready only at 5 Format, 15 Content, 30 Visual', () => {
    const ready = quotaSpread({ format: 5, content: 15, visual: 30 });
    expect(ready.ready).toBe(true);
    expect(ready.warning).toBe('');
    expect(ready.canAdd).toEqual({ format: false, content: false, visual: false });

    const short = quotaSpread({ format: 3, content: 15, visual: 30 });
    expect(short.ready).toBe(false);
    expect(short.canAdd.format).toBe(true);
    expect(short.warning).toBe('Format short by 2 (3 of 5).');

    const over = quotaSpread({ format: 6, content: 15, visual: 30 });
    expect(over.ready).toBe(false);
    expect(over.canAdd.format).toBe(false);
    expect(over.warning).toBe('Format has 6 of 5.');
  });

  it('counts seated families from tags', () => {
    expect(countFamilies([{ tag: 'Format/File' }, { tag: 'Content - Exact' }, { tag: 'Visual - Layout' }])).toEqual({
      format: 1,
      content: 1,
      visual: 1,
    });
  });
});

describe('rubric tags and quotas', () => {
  it('maps every tag to a family', () => {
    for (const tag of RUBRIC_TAGS) expect(['format', 'content', 'visual']).toContain(familyOfTag(tag));
    expect(familyOfTag('garbage')).toBe('content');
  });

  it('puts file type and slide count in Format, named typeface in Visual', () => {
    const format = [
      'The deliverable is an editable PowerPoint presentation in PPTX format.',
      'The presentation contains exactly 18 slides.',
      'The PPTX has the required fonts embedded.',
      'The video playback frame rate is exactly 25 frames per second.',
      'The delivered video has an encoding frame size of 3840 x 2160 pixels.',
    ];
    for (const statement of format) {
      expect(guessTag(statement)).toBe('Format/File');
      expect(correctTag(statement, 'Content - Semantics')).toBe('Format/File');
      expect(familyOfStatement(statement, 'Content - Quantitative')).toBe('format');
    }
    expect(guessTag('The presentation uses the Manrope font family for its slide text.')).toBe('Visual - Branding');
    expect(correctTag('The presentation uses the Manrope font family for its slide text.', 'Content - Semantics')).toBe('Visual - Branding');
    expect(familyOfStatement('The presentation uses the Manrope font family for its slide text.', 'Content - Exact')).toBe('visual');
    expect(familyOfStatement('The title slide names the client review.', 'Content - Exact')).toBe('content');
    expect(correctTag('The deck cites 18 community partners.', 'Content - Exact')).toBe('Content - Exact');
  });

  it('does not treat a cited source filename as a Format claim', () => {
    expect(guessTag('The Westbridge Health logo displayed in the video matches the asset provided in Westbridge_logo_blue_grey.png or Westbridge_logo_white.png rather than a modified or third-party logo mark.')).toBe(
      'Visual - Branding',
    );
    expect(guessTag('The employee access card shown in close-up matches the card visual design provided in Access Card Image.png.')).toBe('Visual - Branding');
    expect(guessTag('The fonts used for on-screen titles match the primary typefaces specified in Westbridge_Health_Brand_Guidelines.pptx.')).toBe('Visual - Branding');
    expect(guessTag('The graphic background elements and title card plates utilize colors from the palette defined in Westbridge_Health_Brand_Guidelines.pptx.')).toBe(
      'Visual - Branding',
    );
    expect(guessTag("Darren's spoken dialogue matches the presenter lines specified in the approved script Westbridge_Access_Card_Script.docx.")).toBe('Content - Semantics');
    expect(guessTag('The aspect ratio of the Westbridge Health logo graphic remains unwarped and unstretched throughout its screen presence.')).toBe('Visual - Branding');
    expect(guessTag('Each Instagram carousel image is delivered as a .png file.')).toBe('Format/File');
    expect(
      guessTag(
        'The Angeli Vineyards crest logo shown in the opening of the delivered video matches the black-and-white line-art design from the input asset files',
      ),
    ).toBe('Visual - Branding');
    expect(
      correctTag(
        'The Angeli Vineyards crest logo shown in the opening of the delivered video matches the black-and-white line-art design from the input asset files',
        'Visual - Layout',
      ),
    ).toBe('Visual - Layout');
    expect(reseatImportedTag('The Westbridge Health logo matches Westbridge_logo_white.png.', 'Format/File')).toBe('Visual - Branding');
    expect(reseatImportedTag('The presentation contains exactly 18 slides.', 'Format/File')).toBe('Format/File');
  });

  it('seats Ali\'s Angeli Vineyards rubric as 5 Format, 15 Content, 30 Visual', () => {
    const statements = JSON.parse(readFileSync(new URL('./fixtures/1704127a-statements.json', import.meta.url), 'utf8')) as string[];
    expect(statements).toHaveLength(50);
    const counts = { format: 0, content: 0, visual: 0 };
    for (const statement of statements) counts[familyOfTag(guessTag(statement))] += 1;
    expect(counts).toEqual({ format: 5, content: 15, visual: 30 });
  });
  it('splits 50 as 5/15/30 and sums to the target', () => {
    expect(familyQuotas(50)).toEqual({ format: 5, content: 15, visual: 30 });
    for (const n of [40, 47, 60]) {
      const q = familyQuotas(n);
      expect(q.format + q.content + q.visual).toBe(n);
    }
  });

  it('keeps the stored family for quota checks even when wording looks like Format', () => {
    const statement = 'The presentation contains exactly 18 slides.';
    expect(familyOfStatement(statement, 'Visual - Layout')).toBe('format');
    expect(seatedFamily({ family: 'visual', tag: 'Visual - Layout', statement })).toBe('visual');
    expect(seatedFamily({ tag: 'Visual - Layout', statement })).toBe('visual');
  });

  it('moves surplus Format seats onto 5/15/30 and leaves seated Content and Visual', () => {
    const format = [
      'The Westbridge Health logo displayed in the video matches the asset provided in Westbridge_logo_blue_grey.png.',
      'The employee access card shown in close-up matches the card visual design provided in Access Card Image.png.',
      'The fonts used for on-screen titles match the primary typefaces specified in Westbridge_Health_Brand_Guidelines.pptx.',
      'The graphic background elements utilize colors from the palette defined in Westbridge_Health_Brand_Guidelines.pptx.',
      'The aspect ratio of the Westbridge Health logo graphic remains unwarped.',
      'The B-roll footage features workplace environments consistent with the architectural style in Location_1.jpg.',
      'The presenter featured on camera matches the individual shown in Darren - Headshot.jpg.',
      'The presenter Darren is visually identifiable based on the reference headshot in File 4 (Darren - Headshot.jpg).',
      "Darren's spoken dialogue matches the presenter lines specified in the approved script.",
      'The audio track contains the supplied corporate music track mixed underneath the spoken dialogue.',
      'The background music track is mixed underneath the spoken dialogue throughout the video.',
      'All required on-screen title cards sit within standard 16:9 title-safe boundaries.',
      'The video playback frame rate is exactly 25 frames per second.',
      'The delivered video has an encoding frame size of 3840 x 2160 pixels.',
      'The video presentation maintains a 16:9 widescreen aspect ratio throughout its duration.',
      'The close-up visual of the access card matches the design shown in Access Card Image.png including Westbridge logo and card layout.',
      'The Westbridge logo maintains its correct aspect ratio without stretching.',
    ].map((statement, index) => ({ id: `f${index}`, family: 'format' as const, tag: 'Format/File', statement }));
    const content = Array.from({ length: 14 }, (_, index) => ({
      id: `c${index}`,
      family: 'content' as const,
      tag: 'Content - Semantics',
      statement: `The script states employee rule number ${index + 1} clearly.`,
    }));
    const visual = Array.from({ length: 19 }, (_, index) => ({
      id: `v${index}`,
      family: 'visual' as const,
      tag: 'Visual - Layout',
      statement: `The title card placement stays aligned on beat ${index + 1}.`,
    }));
    const result = reseatOverQuotaFamilies([...format, ...content, ...visual]);
    expect(countFamilies(result)).toEqual({ format: 5, content: 15, visual: 30 });
    for (const row of result) {
      if (row.id.startsWith('c')) expect(row.family).toBe('content');
      if (row.id.startsWith('v')) expect(row.family).toBe('visual');
    }
    expect(result.find((row) => row.statement.includes('25 frames'))?.family).toBe('format');
    expect(result.find((row) => row.statement.includes('3840'))?.family).toBe('format');
    expect(result.find((row) => row.statement.includes('16:9 widescreen'))?.family).toBe('format');
    expect(result.find((row) => row.statement.includes('Westbridge Health logo displayed'))?.family).toBe('visual');
    expect(result.find((row) => row.statement.includes('spoken dialogue matches'))?.family).toBe('content');
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

  it('reseats file-type and slide-count as format, typeface as visual, despite content tags', () => {
    const bank: BankRow[] = [
      { seedId: 's1', claimKey: 'pptx', statement: 'The deliverable is an editable PowerPoint presentation in PPTX format.', tag: 'Content - Semantics', family: 'content', notes: '' },
      { seedId: 's1', claimKey: 'slides', statement: 'The presentation contains exactly 18 slides.', tag: 'Content - Quantitative', family: 'content', notes: '' },
      { seedId: 's1', claimKey: 'font', statement: 'The presentation uses the Manrope font family for its slide text.', tag: 'Content - Semantics', family: 'content', notes: '' },
      { seedId: 's1', claimKey: 'title', statement: 'The title slide names the client review.', tag: 'Content - Exact', family: 'content', notes: '' },
    ];
    const result = assemble(bank, { format: 2, content: 1, visual: 1 });
    expect(result.seated.filter((r) => r.family === 'format').map((r) => r.claimKey).sort()).toEqual(['pptx', 'slides']);
    expect(result.seated.filter((r) => r.family === 'visual').map((r) => r.claimKey)).toEqual(['font']);
    expect(result.seated.filter((r) => r.family === 'content').map((r) => r.claimKey)).toEqual(['title']);
  });

  it('fills the quota total from leftover tagged rows when a family is short', () => {
    const bank: BankRow[] = [];
    for (let i = 0; i < 8; i++) bank.push(row('s1', i, 'content', 'Content - Exact'));
    const result = assemble(bank, { format: 2, content: 3, visual: 3 });
    expect(result.seated).toHaveLength(8);
    expect(result.seated.every((r) => r.tag === 'Content - Exact' || r.tag === 'Format/File' || r.tag.startsWith('Visual'))).toBe(true);
  });

  it('rewrites name.extension claims to descriptor language before seating', () => {
    const result = assemble(
      [
        {
          seedId: 's1',
          claimKey: 'ratio',
          statement: 'The q3-regional-deck.pptx uses a 16:9 page size.',
          tag: 'Format/File',
          family: 'format',
          notes: '',
        },
      ],
      { format: 1, content: 0, visual: 0 },
    );
    expect(result.seated[0]?.statement).toBe('The delivered presentation uses a 16:9 page size.');
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

describe('legacy snapshot import', () => {
  it('maps live permission keys onto the four app roles', () => {
    expect(mapLegacyRoles(['full_access', 'rubric_team', 'review_team', 'submissions.control'])).toEqual([
      'admin',
      'rubric_creator',
      'reviewer',
      'pm',
    ]);
    expect(mapLegacyRoles(['project_manager', 'rubric_reviewer', 'sme', 'experts'])).toEqual([
      'pm',
      'reviewer',
      'rubric_creator',
    ]);
    expect(assignmentSeat('rubric_team')).toBe('rubric');
    expect(assignmentSeat('review_team')).toBe('review');
    expect(mapLegacyStage('approved')).toBe('stability');
    expect(mapLegacyStage('in_review')).toBe('review');
    expect(mapLegacyStage('draft')).toBe('rubric');
  });

  it('keeps the latest non-superseded run and re-tags its rows', () => {
    const latest = latestLegacyRun([
      { created_at: '2026-10-01T00:00:00Z', native_generation_superseded: false, rows: [] },
      { created_at: '2026-10-02T00:00:00Z', native_generation_superseded: true, rows: [{ statement: 'old' }] },
      { created_at: '2026-10-03T00:00:00Z', rows: [{ id: 's001', tag: 'Content - Semantics', statement: 'The presentation contains exactly 18 slides.', notes: 'claim:slide-count | seed:s012' }] },
    ]);
    const parsed = parseLegacyRubricRows(latest?.rows);
    expect(parsed[0]?.tag).toBe('Format/File');
    expect(parsed[0]?.family).toBe('format');
    expect(parsed[0]?.claimKey).toBe('slide-count');
    expect(factoryStatementsFromLegacy(latest?.rows)).toHaveLength(1);
    expect(parseLegacyRubricRows([{ id: 'b0_1', question: 'Are the captions timed to the spoken audio?' }])).toHaveLength(1);
    const visual = parseLegacyRubricRows([
      {
        family: 'visual',
        statement: 'Added background and effect elements follow the camera movement of the main camera plate without visible sliding relative to the terrain.',
      },
    ]);
    expect(visual[0]?.family).toBe('visual');
    expect(visual[0]?.tag.startsWith('Visual')).toBe(true);
  });

  it('remaps legacy seat ids onto imported statements by wording', () => {
    const seats = mapLegacySeatIds(
      [{ id: 'b0_4', statement: 'The delivered WAV file is encoded in 32-bit PCM audio format.' }],
      [{ id: 'new-1', statement: 'The delivered WAV file is encoded in 32-bit PCM audio format.', claimKey: 'bit-depth-32bit-pcm' }],
    );
    expect(seats.get('b0_4')).toBe('new-1');
    const fromQuestion = factoryStatementsFromLegacy([{ id: 'b1_36', question: 'Does the bottom arrow point directly to the main body of the cake sponge base?' }]);
    expect(mapLegacySeatIds(
      [{ id: 'b1_36', question: 'Does the bottom arrow point directly to the main body of the cake sponge base?' }],
      fromQuestion.map((row) => ({ id: 'new-2', statement: row.statement, claimKey: row.claimKey })),
    ).get('b1_36')).toBe('new-2');
    expect(asLegacyVerdict('Yes')).toBe(true);
    expect(asLegacyVerdict({ answer: 'No' })).toBe(false);
    expect(remapVerdicts({ b0_4: true, missing: false }, seats)).toEqual({ 'new-1': true });
  });

  it('hosts a stability group by internal id, catalog id, or rubric run, and otherwise leaves it unattached', () => {
    const lookup = {
      internalIds: new Set(['internal-1']),
      catalogToInternal: new Map([['catalog-1', 'internal-1']]),
      runIdToInternal: new Map([['run-9', 'internal-2']]),
    };
    expect(legacyStabilityHostId({ submission_id: 'internal-1' }, lookup)).toBe('internal-1');
    expect(legacyStabilityHostId({ submission_id: 'catalog-1' }, lookup)).toBe('internal-1');
    expect(legacyStabilityHostId({ submission_id: 'gone', rubric_run_id: 'run-9' }, lookup)).toBe('internal-2');
    expect(legacyStabilityHostId({ submission_id: 'gone', rubric_run_id: 'missing-run' }, lookup)).toBe(null);
  });

  it('reads Stability from autorate_runs: accepted group if marked, else last complete group, plus reviewed parent', () => {
    const pass = (groupId: string, source: string, score: number, parent?: string) => ({
      groupId,
      ordinal: Number(source.slice(-1)),
      source,
      at: '2026-10-09T15:06:29Z',
      model: parent ? 'Replit Agent — original-source evidence review' : 'gemini',
      scorePercent: score,
      answers: { b0_1: true },
      evidence: { b0_1: 'note' },
      grades: { b0_1: { answer: true, evidence: 'note', statement: 'The file is delivered.' } },
      errors: {},
      evidenceReview: parent ? { kind: 'ai_original_source_review', parentGroupId: parent } : undefined,
    });
    const parent = 'cf61f48f-fdf2-41a3-9778-3aa8a12281af';
    const reviewed = '67b11091-5af7-486c-b6c6-427a0623d556';
    const older = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newerUnmarked = '63780a80-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accepted = 'a954edb2-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const trio = (id: string, scores: [number, number, number], parentId?: string) =>
      [1, 2, 3].map((n, i) => pass(id, `autorate_stability_${n}`, scores[i]!, parentId));

    const noMarker = stabilityGroupsFromAutorate(
      [...trio(parent, [44, 50, 48]), ...trio(reviewed, [46, 46, 46], parent)],
      {},
    );
    expect(noMarker.map((row) => row.group_id)).toEqual([reviewed, parent]);
    expect(noMarker[0]?.evaluation.scores).toEqual([46, 46, 46]);
    expect(noMarker[0]?.parent_group_id).toBe(parent);
    expect(noMarker[0]?.accepted_at).toBe(null);

    const marked = stabilityGroupsFromAutorate(
      [...trio(accepted, [54, 52, 54]), ...trio(newerUnmarked, [50, 50, 54])],
      { __observability_stability_acceptance: JSON.stringify({ groupId: accepted, acceptedAt: '2026-10-12T10:12:00Z', acceptedBy: 'user-1' }) },
    );
    expect(marked.map((row) => row.group_id)).toEqual([accepted]);
    expect(marked[0]?.accepted_at).toBe('2026-10-12T10:12:00Z');

    expect(stabilityGroupsFromAutorate([...trio(older, [48, 48, 46])], null).map((row) => row.group_id)).toEqual([older]);
  });

  it('infers live board lanes from the Catalog workflow graph, not status names', () => {
    const work = 'work-status';
    const handoff = 'handoff-status';
    const catalogStatuses = [{ statusId: work }, { statusId: handoff }, { statusId: 'g' }, { statusId: 'p' }];
    const catalogTransitions = [
      { from: handoff, to: 'g', trigger: 'submit' },
      { from: 'g', to: 'p', trigger: 'approve' },
    ];
    const base = { workStatusId: work, handoffStatusId: handoff, catalogStatuses, catalogTransitions };
    expect(inferLegacyPipeline({ ...base, catalogStatusId: work, assigned: true }).stage).toBe('rubric');
    expect(inferLegacyPipeline({ ...base, catalogStatusId: work, reviewStatus: 'pending' }).stage).toBe('review');
    expect(inferLegacyPipeline({ ...base, catalogStatusId: work, reviewStatus: 'changes_requested' })).toMatchObject({
      stage: 'rubric',
      reviewStatus: 'changes_requested',
    });
    expect(inferLegacyPipeline({ ...base, catalogStatusId: work, reviewStatus: 'approved' }).stage).toBe('stability');
    expect(catalogLooksInboundReady('K.Golden Output Approved')).toBe(true);
    expect(catalogLooksInboundReady('E. Task and Golden Output Approved')).toBe(true);
    expect(catalogLooksInboundReady('H2. Golden Output Ready for Review')).toBe(false);
    expect(inferLegacyPipeline({ ...base, catalogStatusId: work, assigned: false }).stage).toBe('rubric');
    expect(
      inferLegacyPipeline({
        ...base,
        catalogStatuses: [...catalogStatuses, { statusId: 'k-golden-approved', name: 'K.Golden Output Approved' }],
        catalogStatusId: 'k-golden-approved',
        assigned: false,
      }).stage,
    ).toBe('rubric');
    expect(
      inferLegacyPipeline({
        ...base,
        catalogStatuses: [...catalogStatuses, { statusId: 'e-approved', name: 'E. Task and Golden Output Approved' }],
        catalogStatusId: 'e-approved',
        assigned: false,
      }).stage,
    ).toBe('rubric');
    expect(inferLegacyPipeline({ ...base, catalogStatusId: 'g' }).stage).toBe('done');
    expect(inferLegacyPipeline({ ...base, catalogStatusId: 'p' }).stage).toBe('done');
    expect([...submittedCatalogStatusIds({ workStatusId: work, handoffStatusId: handoff, statuses: catalogStatuses, transitions: catalogTransitions })]).toEqual(['handoff-status', 'g', 'p']);
    expect(inferLegacyPipeline({ ...base, catalogStatusId: 'h2', catalogStatusName: 'H2. Golden Output Ready for Review', reviewStatus: 'pending' }).stage).toBe('parked');
    expect(inferLegacyPipeline({ ...base, catalogStatusId: 'off' }).stage).toBe('parked');
    expect(inferLegacyPipeline({ handoffStatus: 'bounced' }).stage).toBe('handoff');
    expect(workStateOf({ stage: 'rubric', rubricAssigneeId: null, reviewStatus: null })).toBe('unassigned');
    expect(workStateOf({ stage: 'rubric', rubricAssigneeId: 'x', reviewStatus: null })).toBe('preparing');
    expect(workStateOf({ stage: 'rubric', rubricAssigneeId: 'x', reviewStatus: 'changes_requested' })).toBe('review_returned');
    expect(workStateOf({ stage: 'review', rubricAssigneeId: 'x', reviewStatus: 'pending' })).toBe('in_review');
    expect(workStateOf({ stage: 'parked', rubricAssigneeId: null, reviewStatus: null })).toBe('other');
    expect(workStateOf({ stage: 'handoff', rubricAssigneeId: 'x', reviewStatus: 'approved', handoffStatus: 'bounced' })).toBe('platform_returned');
    expect(workStateOf({ stage: 'rubric', rubricAssigneeId: 'x', reviewStatus: 'approved', handoffStatus: 'bounced' })).toBe('platform_returned');
    expect(workStateOf({ stage: 'done', rubricAssigneeId: 'x', reviewStatus: 'approved' })).toBe('submitted');
  });
});
