import 'server-only';

import { z } from 'zod';
import { HELPER_CRAFT } from '@/domain/helperCraft';
import type { HelperAnalysisRow, HelperDraft, HelperGrounding } from '@/domain/helper';
import { isHelperGrounding } from '@/domain/helper';
import { aliasTag, tagStyleOf } from '@/domain/rubric';
import { env } from '@/lib/env';
import { generateJson } from '@/lib/ai/gemini';

const FittedScan = z.object({
  fittedIds: z.array(z.string()),
});

const Drafts = z.object({
  drafts: z.array(
    z.object({
      seatId: z.string().optional(),
      statement: z.string(),
      tag: z.string(),
      grounding: z.string(),
      evidence: z.string().optional(),
      golden: z.boolean().optional(),
      ai: z.boolean().optional(),
    }),
  ),
});

const SYSTEM = `You help a rubric writer after seats are already classified. Do not classify.
Two scores: Golden 100 is every seated row true on the human file. Calibration is how many
of those rows this AI pack also passes (under 40, inside 20–50). Stability is spread across
three reruns (≤ 5 points). It is not a 40% score.

Only reword false_on_golden, soft, or output_fitted seats. Same family, same difficulty.
For false_on_golden or soft: retarget the anchor so it is true on this golden and required by
the brief or craft. For output_fitted: the current seat is written off the golden or AI file
to fail this pack. Offer one grounded replacement from the brief, a named input, or a named
craft implicit. Drop the output-specific detail (this mascot, this sofa, this crop).
Do not dumb a contrast seat into “the logo is present”. Do not sample a hex the guide never
named. Do not name slide numbers. Do not stack a second claim. Do not propose canvas
catch-alls, “hierarchy exists”, or generic contrast.

Add drafts have no seatId. They must be brief requirements, one claim, predicted golden true
and AI false. Do not mention Golden or AI in the statement text.

Return JSON only: { "drafts": [{ "seatId"?: "…", "statement": "…", "tag": "…", "grounding": "prompt|input:<role>|craft:<id>", "evidence": "…", "golden"?: true, "ai"?: false }] }`;

const SCAN = `You only scan. Do not rewrite. Do not classify Golden vs AI grades.
Flag a seat when a reader would think it was written from a specific golden or AI
deliverable — a named person, sofa, mascot, crop, sampled hex, “this slide of the
AI file”, or any other file-specific happenstance — rather than a requirement the
brief, a named input, or a named craft implicit would still demand if a different
correct file were delivered.

Do not flag brief locks (page size, a locked spoken line, a named typeface), named
inputs, or named craft implicits. When unsure, do not flag.

Return JSON only: { "fittedIds": ["seat-id", ...] }`;

export async function scanOutputFitted(input: {
  prompt: string;
  inputRoles: readonly string[];
  seats: readonly Pick<HelperAnalysisRow, 'id' | 'statement' | 'tag'>[];
  signal?: AbortSignal;
}): Promise<string[]> {
  if (input.seats.length === 0) return [];
  const craft = Object.entries(HELPER_CRAFT)
    .map(([id, phrase]) => `${id}: ${phrase}`)
    .join('\n');
  const allowed = new Set(input.seats.map((row) => row.id));
  const result = await generateJson({
    model: env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL,
    system: SCAN,
    parts: [
      `--- Task prompt ---\n${input.prompt.trim() || '(none)'}`,
      `--- Named input roles ---\n${input.inputRoles.join(', ') || '(none)'}`,
      `--- Named craft implicits ---\n${craft}`,
      `--- Seated rows ---\n${input.seats.map((row) => `${row.id} | ${row.tag}\n${row.statement}`).join('\n\n')}`,
      'Return only ids from the seated list that read as written off the golden or AI file.',
    ],
    schema: FittedScan,
    temperature: 0.1,
    maxOutputTokens: 2048,
    signal: input.signal,
  });
  return [...new Set(result.value.fittedIds.map((id) => id.trim()).filter((id) => allowed.has(id)))];
}

export async function draftHelperRows(input: {
  prompt: string;
  inputRoles: readonly string[];
  seats: readonly HelperAnalysisRow[];
  signal?: AbortSignal;
}): Promise<HelperDraft[]> {
  const rewrite = input.seats.filter((row) => row.bucket === 'false_on_golden' || row.bucket === 'soft' || row.bucket === 'output_fitted');
  const style = tagStyleOf({ tags: input.seats.map((row) => row.tag), hasCurrentRubric: true });
  const craft = Object.entries(HELPER_CRAFT)
    .map(([id, phrase]) => `${id}: ${phrase}`)
    .join('\n');
  const result = await generateJson({
    model: env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL,
    system: SYSTEM,
    parts: [
      `--- Task prompt ---\n${input.prompt.trim() || '(none)'}`,
      `--- Named input roles ---\n${input.inputRoles.join(', ') || '(none)'}`,
      `--- Named craft implicits ---\n${craft}`,
      `--- Seats that may be reworded ---\n${rewrite
        .map((row) => `${row.id} | ${row.tag} | ${row.bucket} | ${row.reason}\n${row.statement}`)
        .join('\n\n') || '(none)'}`,
      'One reword per listed seat (set seatId). Up to eight Add claims with no seatId that should Yes on Golden and No on this AI pack. Grounding is required.',
    ],
    schema: Drafts,
    temperature: 0.3,
    maxOutputTokens: 4096,
    signal: input.signal,
  });
  return result.value.drafts.flatMap((row) => {
    if (!isHelperGrounding(row.grounding)) return [];
    return [
      {
        seatId: row.seatId?.trim() || undefined,
        statement: row.statement,
        tag: aliasTag(row.tag, style) ?? row.tag,
        grounding: row.grounding as HelperGrounding,
        evidence: row.evidence,
        golden: row.golden,
        ai: row.ai,
      },
    ];
  });
}
