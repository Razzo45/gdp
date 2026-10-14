import 'server-only';

import { z } from 'zod';
import { HELPER_CRAFT } from '@/domain/helperCraft';
import type { HelperAnalysisRow, HelperDraft, HelperGrounding } from '@/domain/helper';
import { isHelperGrounding } from '@/domain/helper';
import { env } from '@/lib/env';
import { generateJson } from '@/lib/ai/gemini';

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

Only reword false_on_golden or soft seats. Same family, same difficulty. Retarget the anchor
so it is true on this golden and required by the brief or craft. Do not dumb a contrast seat
into “the logo is present”. Do not sample a hex the guide never named. Do not stack a second claim.
Do not propose canvas catch-alls, “hierarchy exists”, or generic contrast.

Add drafts have no seatId. They must be brief requirements, one claim, predicted golden true
and AI false. Do not mention Golden or AI in the statement text.

Return JSON only: { "drafts": [{ "seatId"?: "…", "statement": "…", "tag": "…", "grounding": "prompt|input:<role>|craft:<id>", "evidence": "…", "golden"?: true, "ai"?: false }] }`;

export async function draftHelperRows(input: {
  prompt: string;
  inputRoles: readonly string[];
  seats: readonly HelperAnalysisRow[];
  signal?: AbortSignal;
}): Promise<HelperDraft[]> {
  const rewrite = input.seats.filter((row) => row.bucket === 'false_on_golden' || row.bucket === 'soft');
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
        tag: row.tag,
        grounding: row.grounding as HelperGrounding,
        evidence: row.evidence,
        golden: row.golden,
        ai: row.ai,
      },
    ];
  });
}
