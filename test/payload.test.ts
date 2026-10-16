import { describe, expect, it } from 'vitest';
import { inspectSendParts, shouldInlineMedia, tightenSendParts } from '@/lib/ai/gemini';
import { standInValue, mockGradeYes } from '@/lib/ai/standIn';
import { z } from 'zod';

describe('tight send payloads', () => {
  it('never inlines video or audio', () => {
    expect(shouldInlineMedia('video/mp4', 800_000)).toBe(false);
    expect(shouldInlineMedia('audio/mpeg', 500_000)).toBe(false);
    expect(shouldInlineMedia('image/png', 800_000)).toBe(true);
    expect(shouldInlineMedia('application/pdf', 3 * 1024 * 1024)).toBe(false);
    expect(shouldInlineMedia('application/pdf', 800_000)).toBe(true);
  });

  it('clips text, drops blanks, and keeps one copy of each URI', () => {
    const tight = tightenSendParts([
      '   ',
      `TASK CONTEXT:\n${'x'.repeat(20_000)}`,
      { kind: 'uri', mime: 'video/mp4', data: 'https://files.example/vid', label: 'DELIVERABLE: clip.mp4' },
      { kind: 'uri', mime: 'video/mp4', data: 'https://files.example/vid', label: 'again' },
      'STATEMENTS TO GRADE (1):\n[abc] The slide has a title.',
    ]);
    const inspect = inspectSendParts(tight);
    expect(inspect.videoInline).toBe(0);
    expect(inspect.uris).toBe(1);
    expect(inspect.textChars).toBeLessThanOrEqual(12_000 * 2 + 80);
    expect(tight.some((part) => typeof part === 'string' && part.includes('STATEMENTS TO GRADE'))).toBe(true);
  });
});

describe('429 stand-in', () => {
  const Verdicts = z.object({
    verdicts: z.array(z.object({ id: z.string(), answer: z.enum(['Yes', 'No']), evidence: z.string() })),
  });
  const BankRows = z.object({
    rows: z.array(z.object({ claim_key: z.string(), statement: z.string(), tag: z.string(), notes: z.string() })),
  });

  it('grades Golden Yes and AI output at a stable ~30%', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(mockGradeYes(id, false)).toBe(true);
    expect(mockGradeYes(id, true)).toBe(mockGradeYes(id, true));
    const golden = standInValue({
      system: 'You are a strict rubric autorater.',
      parts: [`CONSIDERED_OUTPUTS: golden-q3.pptx\nSTATEMENTS TO GRADE (1):\n[${id}] The footer is present.`],
      schema: Verdicts,
    });
    expect(golden.verdicts[0]?.answer).toBe('Yes');
    const ai = standInValue({
      system: 'You are a strict rubric autorater.',
      parts: [`CONSIDERED_OUTPUTS: Meridian Foods readout.pptx\nSTATEMENTS TO GRADE (1):\n[${id}] The footer is present.`],
      schema: Verdicts,
    });
    expect(ai.verdicts[0]?.answer).toBe(mockGradeYes(id, true) ? 'Yes' : 'No');
  });

  it('drafts helper repair and add rows from stuck seats', () => {
    const Drafts = z.object({
      drafts: z.array(
        z.object({
          seatId: z.string().optional(),
          statement: z.string(),
          tag: z.string(),
          grounding: z.string(),
          evidence: z.string().optional(),
        }),
      ),
    });
    const drafted = standInValue({
      system: 'You help a rubric writer after seats are already classified. Do not classify.',
      parts: [
        '--- Task prompt ---\nDeliver a 16:9 staff deck. The spoken narration states that Westbridge is introducing a new employee access card.',
        '--- Seats that need work ---\n11111111-1111-4111-8111-111111111111 | Visual - Layout | golden_fail | Golden No\nType sits past the edge.',
      ],
      schema: Drafts,
    });
    expect(drafted.drafts.some((row) => row.seatId === '11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(drafted.drafts.some((row) => row.grounding === 'prompt' && !row.seatId)).toBe(true);
    expect(drafted.drafts.every((row) => row.statement.length > 8 && !row.statement.includes('?'))).toBe(true);
  });

  it('returns an empty fitted-id list for the helper output scan', () => {
    const scanned = standInValue({
      system: 'You only scan. Do not rewrite. Do not classify Golden vs AI grades.',
      parts: ['--- Seated rows ---\nkeep-1 | Content - Semantics\nThe spoken narration names the card.'],
      schema: z.object({ fittedIds: z.array(z.string()) }),
    });
    expect(scanned.fittedIds).toEqual([]);
  });

  it('expands a seed into lint-shaped rows', () => {
    const rows = standInValue({
      system: 'You are a senior practitioner turning ONE expert human seed into GRANULAR Precise Boolean Yes/No rows. Emit UP TO 3 rows',
      parts: ['=== EXPERT SEED ===\nseed_id: seed-1\ntheme: footer\nstatement: The footer matches the brief.'],
      schema: BankRows,
    });
    expect(rows.rows.length).toBe(3);
    expect(rows.rows.every((row) => row.claim_key && !row.statement.includes('?'))).toBe(true);
  });
});
