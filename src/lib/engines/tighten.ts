import 'server-only';

import { z } from 'zod';
import { STABILITY_PASSES } from '@/domain/gates';
import { aliasTag, tagsForStyle, type TagStyle } from '@/domain/rubric';
import type { LockDraft, VerifiedLock } from '@/domain/tighten';
import { generateJson } from '@/lib/ai/gemini';
import type { PreparedFile } from '@/lib/ai/media';
import { env } from '@/lib/env';
import { gradeStatements } from './autorater';

const Mined = z.object({
  locks: z.array(
    z.object({
      statement: z.string(),
      tag: z.string(),
      sourceLabel: z.string(),
      quote: z.string(),
      basis: z.enum(['verbatim', 'interpretation']),
      rationale: z.string(),
    }),
  ),
});

const SYSTEM = `You write rubric locks for a task whose AI output scores too high against the rubric.

You receive the task brief, its acceptance criteria, the task inputs, the GOLDEN OUTPUT (a deliverable that
meets the brief) and the AI OUTPUT (the deliverable being scored). Read every page or frame of both.

Find requirements that the brief, acceptance criteria or an input sets, that the GOLDEN OUTPUT meets and the
AI OUTPUT misses or gets wrong. Look for: sections or areas the brief asks for that are missing, rules from an
input that are never stated or shown, wrong or missing values, things the brief says must be "demonstrated"
or "shown" that are only listed, incorrect-use or example coverage the brief asks for, copy that is changed,
clipped or cut off, and specifications such as size, proportion or safe area that are not met.

Turn each defect into one lock:
- One requirement per lock, written as an affirmative statement where Yes is the good outcome. No questions.
- Never join two separate checks with "and" or "or" (for example "nothing crosses the page edge or overlaps").
  Listing the exact values of a single rule is fine.
- One lock per defect. Never write a second lock that checks the same requirement in other words.
- Describe the requirement, not the golden output. A different correct deliverable must also pass it.
- State what the task requires, not a flaw you saw in the AI OUTPUT. "Does not frame the header in a grey border",
  "does not leave half the layout empty" or "photos are not cropped square" describe one deliverable's mistakes;
  write them only when the brief, acceptance criteria or an input prohibits exactly that.
- Never mention the golden, the AI, a reference file, a file name, or a page, slide or frame number.
- Do not copy the golden's layout, section titles, wording or creative choices that the brief leaves open.
- Only use colour values, numbers and quoted wording that appear in the brief, acceptance criteria or inputs.
- When an input lists several separate rules, you may write one lock per rule.
- A lock may interpret what a brief line requires in testable terms; mark it "interpretation" and explain in one sentence.
- Do not restate any seat already in the rubric.
- Avoid taste ("looks professional", "is visually appealing") and generic catch-alls.

For every lock give:
- sourceLabel: "Brief", "Acceptance criteria", or the input's name.
- quote: copy one line from that source, word for word, at least five words long, that grounds the lock.
- basis: "verbatim" when the lock restates the line, "interpretation" when it reads what the line requires.
- rationale: one sentence a reviewer can check.

Return JSON only: { "locks": [{ "statement", "tag", "sourceLabel", "quote", "basis", "rationale" }] }`;

/** Two calls run side by side, each looking at one half of the rubric. */
export type MineFocus = 'content' | 'presentation';

const FOCUS: Record<MineFocus, (style: TagStyle) => string> = {
  content: () => 'Only look for Format/File and Content defects: what the deliverable says, which sections and rules it states, exact values and copy, file and page specifications.',
  presentation: (style) =>
    `Only look for ${style === 'craft' ? 'Craft' : 'Visual'} defects: how rules are shown and applied, required demonstrations and incorrect-use examples, placement, proportion, clear space, consistency and legibility.`,
};

interface MineInput {
  focus: MineFocus;
  brief: string;
  acceptance: string;
  inputs: readonly PreparedFile[];
  golden: readonly PreparedFile[];
  ai: readonly PreparedFile[];
  kept: readonly { statement: string; tag: string }[];
  already: readonly string[];
  want: number;
  style: TagStyle;
  signal?: AbortSignal;
}

export function minePrompt(input: MineInput) {
  const tags = tagsForStyle(input.style);
  return {
    model: env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL,
    system: SYSTEM,
    parts: [
      `--- Brief ---\n${input.brief.trim() || '(none)'}`,
      `--- Acceptance criteria ---\n${input.acceptance.trim() || '(none)'}`,
      `--- Allowed tags ---\n${tags.join('\n')}\nFormat/File for the file, pages and dimensions. Content tags for what the deliverable says. ${input.style === 'craft' ? 'Craft' : 'Visual'} tags for how it shows, applies and lays out the rules.`,
      `--- Seats already in the rubric (do not restate) ---\n${input.kept.map((row) => `(${row.tag}) ${row.statement}`).join('\n') || '(none)'}`,
      `--- Locks already proposed or rejected (do not repeat) ---\n${input.already.join('\n') || '(none)'}`,
      '--- TASK INPUTS ---',
      ...input.inputs.flatMap((file) => file.parts),
      '--- GOLDEN OUTPUT (meets the brief) ---',
      ...input.golden.flatMap((file) => file.parts),
      '--- AI OUTPUT (being scored) ---',
      ...input.ai.flatMap((file) => file.parts),
      `${FOCUS[input.focus](input.style)} Return up to ${input.want} locks, strongest and most clearly required first.`,
    ],
  };
}

export async function mineLocks(input: MineInput): Promise<LockDraft[]> {
  const result = await generateJson({
    ...minePrompt(input),
    schema: Mined,
    temperature: 0.3,
    maxOutputTokens: 16_384,
    thinkingLevel: 'LOW',
    timeoutMs: 4 * 60_000,
    httpTimeoutMs: 4 * 60_000,
    signal: input.signal,
  });
  return result.value.locks.flatMap((row) => {
    const tag = aliasTag(row.tag.trim(), input.style);
    if (!tag) return [];
    return [{ statement: row.statement.trim(), tag, sourceLabel: row.sourceLabel.trim(), quote: row.quote.trim(), basis: row.basis, rationale: row.rationale.trim() }];
  });
}

const Review = z.object({
  compound: z.array(z.string()),
  same: z.array(z.object({ id: z.string(), as: z.string() })),
  fitted: z.array(z.string()),
});

const REVIEW_SYSTEM = `You check draft rubric statements before they are graded.

fitted: ids of drafts that describe a specific mistake in one deliverable (an unapproved border, a layout left
half empty, photos cropped square) instead of a requirement the TASK TEXT states or clearly implies. A draft
that restates or applies a rule from the task text is not fitted.

compound: ids of drafts that check two or more separate things, so one could pass while the other fails
(for example "no text crosses the page edge or overlaps other elements"). A list of the exact values of one
rule is a single check, not compound.

same: pairs where a draft checks the same requirement as another draft or an existing seat, even in other
words or at a different scope (for example "states each pillar definition word for word" and "states the
Simplify Work definition word for word"). "as" is the other id. A rule and its prohibition are the same
requirement ("icons on dark backgrounds sit on a White circle" and "do not place an icon directly on a dark
background"). A rule being stated and the same rule being shown as an example are different requirements.

Return JSON only: { "compound": [ids], "same": [{ "id", "as" }], "fitted": [ids] }`;

/** One fast text-only call: which drafts are compound, fitted to one deliverable, or repeat a seat or another draft. */
export async function reviewDrafts(input: { drafts: readonly { id: string; statement: string }[]; existing: readonly { id: string; statement: string }[]; taskText: string; signal?: AbortSignal }) {
  if (input.drafts.length === 0) return { compound: [], same: [], fitted: [] };
  const result = await generateJson({
    model: env().GEMINI_MODEL,
    system: REVIEW_SYSTEM,
    parts: [
      `TASK TEXT (brief, acceptance criteria, inputs):\n${input.taskText}`,
      `EXISTING SEATS:\n${input.existing.map((row) => `[${row.id}] ${row.statement}`).join('\n') || '(none)'}`,
      `DRAFTS:\n${input.drafts.map((row) => `[${row.id}] ${row.statement}`).join('\n')}`,
    ],
    schema: Review,
    temperature: 0,
    maxOutputTokens: 4096,
    thinkingLevel: 'LOW',
    timeoutMs: 90_000,
    signal: input.signal,
  });
  return result.value;
}

const Core = z.object({ core: z.array(z.string()) });

export const CORE_SEATS_MAX = 10;

const CORE_SYSTEM = `You pick the core seats of a rubric: the ones a reviewer would expect in any rubric for this task
because they check content the brief explicitly asks the deliverable to contain (for example the colour palette
with its values, the core message, required definitions). Pick at most ${CORE_SEATS_MAX}, most central first.
Do not pick seats about file format, page counts, polish or taste.

Return JSON only: { "core": [ids] }`;

/** Seats the tool must not retire just because both files pass them. */
export async function coreSeats(input: { seats: readonly { id: string; statement: string }[]; taskText: string; signal?: AbortSignal }): Promise<string[]> {
  const result = await generateJson({
    model: env().GEMINI_MODEL,
    system: CORE_SYSTEM,
    parts: [`TASK TEXT (brief, acceptance criteria, inputs):\n${input.taskText}`, `SEATS:\n${input.seats.map((row) => `[${row.id}] ${row.statement}`).join('\n')}`],
    schema: Core,
    temperature: 0,
    maxOutputTokens: 2048,
    thinkingLevel: 'LOW',
    timeoutMs: 90_000,
    signal: input.signal,
  });
  const known = new Set(input.seats.map((row) => row.id));
  return result.value.core.filter((id) => known.has(id)).slice(0, CORE_SEATS_MAX);
}

/** Grades drafts with the real autorater: golden once, AI output once per Stability pass. Nothing is saved. */
export async function verifyLocks(input: {
  drafts: readonly (LockDraft & { id: string })[];
  golden: PreparedFile[];
  ai: PreparedFile[];
  taskContext: string;
  taskBody: string;
  acceptanceCriteria: string;
}): Promise<VerifiedLock[]> {
  if (input.drafts.length === 0) return [];
  const statements = input.drafts.map((draft, index) => ({ id: draft.id, seat: 900 + index, statement: draft.statement, tag: draft.tag, scope: 'output' as const, inputFileIds: [], outputFile: null }));
  const base = { statements, inputs: [], taskContext: input.taskContext, taskBody: input.taskBody, acceptanceCriteria: input.acceptanceCriteria };
  const goldenRun = gradeStatements({ ...base, outputs: input.golden });
  const first = await gradeStatements({ ...base, outputs: input.ai });
  const rest = await Promise.all(Array.from({ length: STABILITY_PASSES - 1 }, () => gradeStatements({ ...base, outputs: input.ai, inventoryByKey: first.inventoryByKey })));
  const golden = await goldenRun;
  const passes = [first, ...rest];
  return input.drafts.map((draft) => ({
    ...draft,
    golden: golden.answers[draft.id] ?? null,
    goldenEvidence: golden.evidence[draft.id] ?? golden.errors[draft.id] ?? '',
    ai: passes.map((pass) => pass.answers[draft.id] ?? null),
    aiEvidence: passes.map((pass) => pass.evidence[draft.id] ?? pass.errors[draft.id] ?? ''),
  }));
}
