import 'server-only';

import { z } from 'zod';
import { lintStatement, toAffirmativeStatement, type LintResult } from '@/domain/lint';
import { env } from '@/lib/env';
import { generateJson } from '@/lib/ai/gemini';

/**
 * One-statement rewrites for the seat actions: Polish (same claim, cleaner
 * wording), Harden (same concern, stronger anchors), Fix lint (repair only
 * the failed attributes). Returns a proposal; the creator decides.
 */

export type RewriteMode = 'polish' | 'harden' | 'lint';

const Proposal = z.object({
  statement: z.string(),
  rationale: z.string().default(''),
});

const SYSTEM = `You rewrite ONE rubric statement for foundation-model evaluation. A statement is an
affirmative Precise Boolean proposition: "Yes" means the desired state holds. Never a
question. One testable claim. No invented hex colours, brand strings, filenames or
numbers that are absent from the original statement or the task context.

Return JSON only: { "statement": "…", "rationale": "one short sentence" }`;

const MODE_INSTRUCTION: Record<RewriteMode, string> = {
  polish: `MODE: POLISH. Keep the exact same claim and the same strictness. Make it shorter,
clearer and unambiguous for two independent graders. Do not add or remove constraints.`,
  harden: `MODE: HARDEN. Keep the same concern but make it more falsifiable and discriminative:
prefer an operational anchor (count, size, ratio, exact string, "free of <named defect>",
"matches <named input>") over soft words. Only use anchors that appear in the original
statement or the task context. One claim only.`,
  lint: `MODE: FIX LINT. The statement failed the listed lint attributes. Change only what is
needed to pass them while keeping the same claim. If it cannot be fixed without changing
the claim, return the original statement unchanged and explain why in the rationale.`,
};

export async function rewriteStatement(input: {
  statement: string;
  tag: string;
  mode: RewriteMode;
  taskContext: string;
  lintReasons?: string[];
  model?: string;
}): Promise<{ proposal: string; rationale: string; lint: LintResult; changed: boolean }> {
  const model = input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL;
  const parts = [
    MODE_INSTRUCTION[input.mode],
    `--- Task context ---\n${input.taskContext.trim() || '(none)'}`,
    `--- Statement ---\ntag: ${input.tag}\nstatement: ${input.statement}`,
    ...(input.lintReasons?.length ? [`--- Failed lint ---\n${input.lintReasons.join('\n')}`] : []),
  ];
  const result = await generateJson({ model, system: SYSTEM, parts, schema: Proposal, temperature: input.mode === 'harden' ? 0.4 : 0.2, maxOutputTokens: 1024 });
  const proposal = toAffirmativeStatement(result.value.statement);
  const lint = lintStatement({ statement: proposal, tag: input.tag });
  return { proposal, rationale: result.value.rationale.trim(), lint, changed: proposal.trim() !== input.statement.trim() };
}
