import 'server-only';

import { z } from 'zod';
import { assemble, type BankRow } from '@/domain/assemble';
import { allPass, lintStatement, nearDuplicate, toAffirmativeStatement, type LintResult, type LintVerdicts, LINT_ATTRIBUTES } from '@/domain/lint';
import { enhancerRowsPerSeed, extractSeedsFromNotes, shouldExtractNotes } from '@/domain/seeds';
import { inferFileScope } from '@/domain/fileScope';
import { describeNamedFiles } from '@/domain/fileLanguage';
import { aliasTag, correctTag, familyOfTag, familyQuotas, isRubricTag, MAX_SEEDS, RUBRIC_TARGET, tagsForStyle, type Family, type TagStyle } from '@/domain/rubric';
import { env } from '@/lib/env';
import { GeminiError, generateJson, type MediaPart } from '@/lib/ai/gemini';
import type { PreparedFile } from '@/lib/ai/media';

/**
 * Rubric factory, ported from the play-by-play console.
 *
 *   collect every distinct expert seed (never collapse a list)
 *                → read the task inputs once (observe, do not judge)
 *                → (per seed) enhance into a granular bank against that account
 *                → strength-rank the bank (how well each row separates weak work)
 *                → deterministic assemble: lint, de-dup, seat the strongest rows
 *                → LLM 8-attribute lint with claim-preserving rewrites
 *
 * The model expands and judges wording; the code decides what is seated.
 */

export interface Seed {
  id: string;
  theme: string;
  statement: string;
  tag?: string;
}

export type FactoryStage =
  | 'reading'
  | 'seeding'
  | 'enhancing'
  | 'seed_done'
  | 'seed_thin'
  | 'seed_failed'
  | 'ranking'
  | 'assembling'
  | 'linting'
  | 'lint_chunk_failed';

export interface FactoryInput {
  seeds: Seed[];
  prompt: string;
  taskContext: string;
  /** Operator rough notes — the seeder turns these into expert seeds. */
  notes?: string;
  /** Written account of the inputs from the read-once pass. */
  observed?: string;
  /** Task inputs for grounding (hex, names, counts). Media allowed. */
  inputs: PreparedFile[];
  /** Golden / current deliverables used only to freeze per-seat file scope. */
  deliverables?: { id: string; name: string }[];
  target?: number;
  model?: string;
  onStage?: (stage: FactoryStage, detail: Record<string, unknown>) => Promise<void> | void;
  tagStyle?: TagStyle;
}

export type { BankRow };

export interface FactoryStatement {
  family: Family;
  tag: string;
  statement: string;
  notes: string;
  claimKey: string;
  origin: 'factory';
  lint: LintResult;
  scope: 'output' | 'inputs';
  inputFileIds: string[];
  outputFile: string | null;
  strength?: number;
}

export interface FactoryReport {
  seeds: number;
  bankSize: number;
  droppedByLint: number;
  droppedAsDuplicate: number;
  seated: number;
  quotas: Record<Family, number>;
  seatedByFamily: Record<Family, number>;
  shortfall: Record<Family, number>;
  aiLintFailures: number;
  rewritesApplied: number;
  ranked: number;
  observed: boolean;
  model: string;
  calls: number;
  totalTokens: number;
}

const BankRows = z.object({
  rows: z.array(
    z.object({
      claim_key: z.string(),
      statement: z.string(),
      tag: z.string(),
      notes: z.string().default(''),
    }),
  ),
});

const Seeds = z.object({
  seeds: z.array(z.object({ theme: z.string(), statement: z.string(), tag: z.string() })).max(MAX_SEEDS),
});

const LintRows = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      overall: z.enum(['pass', 'fail']),
      verdicts: z.record(z.string(), z.enum(['pass', 'fail'])).optional(),
      rewrite_suggestion: z.string().optional(),
    }),
  ),
});

const Seen = z.object({
  account: z.array(z.object({ file: z.string(), what: z.string(), observed: z.array(z.string()).default([]) })),
});

const Strength = z.object({
  scores: z.array(z.object({ id: z.string(), strength: z.number().int().min(0).max(100) })),
});

function tagList(style: TagStyle): string {
  return tagsForStyle(style).join('|');
}

function familyWord(style: TagStyle): string {
  return style === 'craft' ? 'Craft' : 'Visual';
}

function enhancerSystem(style: TagStyle): string {
  const list = tagList(style);
  const family = familyWord(style);
  const how = style === 'craft' ? 'how it is made' : 'how it looks';
  return `You are a senior practitioner in the TASK ROLE turning ONE expert human
seed into many GRANULAR Precise Boolean Yes/No rubric rows for foundation-model eval.

Think like that professional on a real job — not like a student checking only what
the client typed. The expert seed is the INTENT. Expand it into falsifiable
production-QA checks peers in THIS ROLE would run (any industry).

Return JSON only: { "rows": [ { "claim_key": "kebab-case-unique-id", "statement": "…", "tag": "${list}", "notes": "short why" } ] }

=== HARD RULES ===
- Emit UP TO {{TARGET_COUNT}} rows (aim for {{TARGET_COUNT}}). Each row is a distinct failure mode of THIS seed.
- Keep the expert INTENT (theme). Do not change the topic to a different concern.
- Exactly ONE testable claim per statement (non-stacked).
- statement MUST be an affirmative proposition (Precise Boolean statement). Yes means the statement holds.
- FORBIDDEN: "?" anywhere in statement. Do NOT emit interrogatives (no trailing ?, no Does/Do/Is/Are/Can/Will/Has/Have openers).
- NEVER write a filename or name.extension (no deck.pptx, hero.mp4, brand-guide.pdf).
  Name the file by role: "the delivered presentation", "the delivered video",
  "the delivered image", "the source workbook", "the brand guide".
- Do not invent output filenames or grade planned filenames.
- Default handoff is ONE deliverable. Unless the CLIENT PROMPT clearly requires multiple
  deliverables, FORBIDDEN: statements that require an extra file/variant in the package.
- Prefer operational anchors: verbatim #RRGGBB from INPUT CONTEXT, px/pt, counts,
  exact strings, geometry, contrast ratios, aspect ratios, file validity.
- Palette hex / brand strings: NEVER invent #hex or quoted brand copy absent from the
  CLIENT PROMPT or INPUT CONTEXT.
- Soft vibe words without a measurement or grounded anchor are illegal.
- Prefer discriminative checks: exact counts/specs, free-of defects, rather-than wrong form,
  fidelity to named reference inputs. Avoid bare inventory ("an X is included").
- Emit several FAILURE-MODE rows for THIS medium (defects peers reject even when the output
  still looks polished). Derive from the role — do not paste another field's checklist.
- claim_key unique; kebab-case; NAMES THE DEFECT/SPEC being tested, not your wording.
  No seed ids, no numeric suffixes, no disambiguators — a key needing a suffix to be
  unique means the row is a re-assert and will be dropped.
- ONE ROW PER CLAIM — HARD FAILURE to restate a claim in different words, including
  claims already in PREVIOUSLY USED claim_keys. Paraphrases are detected and collapsed
  after you answer — duplicates only waste your budget.
- Each row must fail on a DIFFERENT concrete defect. Before emitting a row, ask:
  "which distinct mistake would flip this to No?" If two rows share that mistake,
  drop one and cover a new failure mode instead.
- Tags: Format/File rows test the file itself (type, size, dimensions, page/slide count,
  fonts embedded, naming, validity). Slide count and file type are NEVER Content.
  Named font/typeface is ${family} (brand), not Format — unless the claim is that fonts
  are embedded in the file. Content rows test what it says/contains. ${family} rows
  test ${how}.`;
}

function seederSystem(style: TagStyle): string {
  const list = tagList(style);
  const cover = style === 'craft' ? 'the craft of this medium' : 'the visual craft of this medium';
  return `You are a senior practitioner in the TASK ROLE. Read the CLIENT PROMPT, the
TASK CONTEXT, and OPERATOR ROUGH NOTES (when present) and write EVERY distinct
EXPERT SEED a peer in this role would QA before handoff — as many as the material
supports, up to ${MAX_SEEDS}. One seed per distinct check. Do NOT collapse a
numbered or bulleted list into a handful of themes. When notes are present, turn
those notes into seeds; do not invent a different rubric. Cover format/delivery,
the content the brief demands, and ${cover}. Each seed is
one theme with one representative affirmative statement (no question marks, no filenames).

Return JSON only: { "seeds": [ { "theme": "short theme", "statement": "affirmative statement", "tag": "${list}" } ] }`;
}

function tagOnChannel(statement: string, suggested: string | undefined, style: TagStyle): string {
  const aliased = suggested && isRubricTag(suggested) ? aliasTag(suggested, style) ?? suggested : undefined;
  return correctTag(statement, aliased, style);
}

const SEEN_SYSTEM = `You are looking at work somebody delivered, so that precise checks can be written about it afterwards.

Describe what is actually there. For each attachment say what it is, then list the concrete, checkable things you can see — counts, proportions, where things sit, what is written, what is consistent and what is not.

Rules:
- Observe, never judge. "The title sits in the lower third" is an observation; "the title is well placed" is not.
- Only what is visible. If you cannot tell, leave it out rather than guessing — an invented detail becomes a rubric check about something that is not there.
- Be specific where specificity is available: numbers, positions, colours, counts of slides or pages.
- Say nothing about quality, taste, or whether the work is good.

Return JSON only: { "account": [ { "file": "name", "what": "what this file is", "observed": ["checkable fact", …] } ] }`;

const STRENGTH_SYSTEM = `You rate how well each rubric statement separates strong work from weak work.

Score 0-100: how likely is a competent-looking but mediocre submission to FAIL this check?
High (70-100): specific failure modes, exact locks, measurements, reference fidelity.
Low (0-40): soft presence and taste — mediocre work passes these, so they carry little signal.

Return JSON only: { "scores": [ { "id": "b1", "strength": 0-100 } ] }`;

const LINTER_SYSTEM = `You are a rubric linter. For each statement in the list, evaluate it against ALL
of the following attributes. Return one object per statement.

Be strict but fair. Do NOT fail a statement only because it contains the word "and" —
fail NON_STACKED only when there are two separable testable claims. Do NOT fail
FALSIFIABLE when a subjective-sounding word is paired with a hard operational anchor
(number, hex, px, exact filename, "at most N").

STATEMENT FORM (required before other attributes):
- Each row must be an affirmative Precise Boolean statement (desired state).
- FAIL if the text is interrogative: ends with "?" OR opens with Does/Do/Is/Are/Can/Will/Has/Have.
- rewrite_suggestion (when provided) MUST be an affirmative statement — must NOT end with "?".

Attributes (each is pass/fail):
1. falsifiable — binary with no room for taste. Fail on empty praise words ("professional",
   "good", "appropriate", "polished", "cohesive", "modern", "high-quality") WITHOUT an
   operational anchor. ALWAYS PASS when peer-gradable via framing: free of / rather than a
   named wrong state; match / consistent with an attached reference; counts, sizes,
   ratios, hex, exact strings from the brief/inputs.
2. universal — any competent professional in the same occupation answers the same way.
3. unambiguous — two qualified reviewers interpret it the same way; critical nouns defined.
4. self_contained — answerable from the output file(s) + statement text alone (naming an
   attached input as reference is OK). Fail if a live URL or external convention is needed.
5. non_stacked — exactly one testable claim. Joining nouns inside one claim is NOT a fail.
6. timeless — no "recent", "current", "as of today", "trending", or a year that will go
   stale. Locked verbatim copy inside quotes is exempt.
7. expected_yes — "Yes" means the statement holds (the model did the right thing).
   Fail: "The design has visual clutter." Pass: "The slide is free of overlapping text."
8. file_addressed_present — always pass here (file scope is held outside the statement).

Set overall to "pass" only if EVERY verdict is pass.

CRITICAL — do not ruin the assembled rubric:
- Prefer PASS when the row is already a single peer-gradable craft check.
- When overall is fail, rewrite_suggestion must be ONE replacement statement that fixes
  ONLY the failed attributes, keeps the SAME claim (never substitutes a different
  constraint, never invents a colour/hex the original did not ask about), still passes
  all 8, and is affirmative.
- If you cannot fix the row without changing the claim, set rewrite_suggestion to ""
  and keep overall "fail" — a human will edit. Empty is better than a claim swap.

Return JSON only: { "rows": [ { "id": "…", "overall": "pass" } | { "id": "…", "overall": "fail", "verdicts": { "falsifiable": "pass|fail", … all 8 … }, "rewrite_suggestion": "…" } ] }`;

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

async function poolMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

function contextParts(input: FactoryInput): (string | MediaPart)[] {
  const parts: (string | MediaPart)[] = [];
  parts.push(`=== CLIENT PROMPT ===\n${clipText(input.prompt.trim() || '(none)', 8_000)}`);
  parts.push(`=== TASK CONTEXT ===\n${clipText(input.taskContext.trim() || '(none)', 8_000)}`);
  if (input.notes?.trim()) parts.push(`=== OPERATOR ROUGH NOTES (turn these into expert seeds / checks) ===\n${clipText(input.notes.trim(), 20_000)}`);
  if (input.observed?.trim()) {
    parts.push(`=== OBSERVED TASK INPUTS (facts only; do not invent beyond this account) ===\n${clipText(input.observed.trim(), 12_000)}`);
  }
  if (input.inputs.length && !input.observed?.trim()) {
    parts.push(`=== INPUT CONTEXT (${input.inputs.length} task input file(s)) ===`);
    let media = 0;
    for (const file of input.inputs) {
      for (const part of file.parts) {
        if (typeof part === 'string') parts.push(clipText(part, 4_000));
        else if (media < 6) {
          parts.push(part);
          media += 1;
        }
      }
    }
  }
  return parts;
}

/** Per-seed expand: brief + the read-once digest. Never re-attach files or the full notes list. */
function enhanceParts(input: FactoryInput): (string | MediaPart)[] {
  const parts: (string | MediaPart)[] = [
    `=== CLIENT PROMPT ===\n${clipText(input.prompt.trim() || '(none)', 8_000)}`,
    `=== TASK CONTEXT ===\n${clipText(input.taskContext.trim() || '(none)', 8_000)}`,
  ];
  if (input.observed?.trim()) {
    parts.push(`=== OBSERVED TASK INPUTS (facts only; do not invent beyond this account) ===\n${clipText(input.observed.trim(), 12_000)}`);
    return parts;
  }
  if (input.inputs.length) {
    parts.push(`=== INPUT CONTEXT (${input.inputs.length} task input file(s), text only) ===`);
    for (const file of input.inputs) {
      for (const part of file.parts) {
        if (typeof part === 'string') parts.push(clipText(part, 4_000));
      }
    }
  }
  return parts;
}

const OBSERVE_TEXT = 12_000;

/** Text + images only. Office PDFs hang Gemini on a single observe call. */
function observeParts(inputs: PreparedFile[]): (string | MediaPart)[] {
  const parts: (string | MediaPart)[] = [
    'Describe each file from the text facts (and any attached images). Documents are given as FILE FACTS + text digest — do not expect a PDF.',
  ];
  for (const file of inputs) {
    parts.push(`FILE: ${file.name} (${file.delivery})`);
    for (const part of file.parts) {
      if (typeof part === 'string') parts.push(part.length > OBSERVE_TEXT ? `${part.slice(0, OBSERVE_TEXT)}\n…(truncated for observe)` : part);
      else if (part.mime.startsWith('image/')) parts.push(part);
    }
  }
  return parts;
}

function localAccount(inputs: PreparedFile[]): string {
  return inputs
    .map((file) => {
      const text = file.parts.filter((part): part is string => typeof part === 'string').join('\n');
      const clipped = text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
      return `${file.name} — ${file.delivery}\n${clipped}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

/** One look at the inputs. Later stages read this text instead of the files again. */
async function describeWork(input: FactoryInput): Promise<{ account: string | null; tokens: number }> {
  const fallback = localAccount(input.inputs);
  try {
    const result = await generateJson({
      model: input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL,
      system: SEEN_SYSTEM,
      parts: observeParts(input.inputs),
      schema: Seen,
      temperature: 0.1,
      maxOutputTokens: 4096,
      timeoutMs: 45_000,
    });
    const account = result.value.account
      .map((entry) => [`${entry.file} — ${entry.what}`, ...entry.observed.map((line) => `  - ${line}`)].join('\n'))
      .join('\n\n')
      .trim();
    return { account: account || fallback || null, tokens: result.usage.totalTokens };
  } catch {
    return { account: fallback || null, tokens: 0 };
  }
}

/** Scores how well each bank row separates strong work from weak. Failed batches are skipped. */
async function rankStrength(input: { model?: string; rows: BankRow[] }): Promise<{ ranked: number; tokens: number; calls: number }> {
  const tagged = input.rows.map((row, i) => ({ id: `b${i + 1}`, row }));
  const batches: (typeof tagged)[] = [];
  for (let i = 0; i < tagged.length; i += 50) batches.push(tagged.slice(i, i + 50));
  let ranked = 0;
  let tokens = 0;
  let calls = 0;
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const result = await generateJson({
          model: input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL,
          system: STRENGTH_SYSTEM,
          parts: [batch.map((item) => `${item.id}: ${item.row.statement}`).join('\n')],
          schema: Strength,
          temperature: 0.1,
          maxOutputTokens: 8192,
        });
        calls += 1;
        tokens += result.usage.totalTokens;
        const byId = new Map(batch.map((item) => [item.id, item.row]));
        for (const score of result.value.scores) {
          const row = byId.get(score.id);
          if (!row) continue;
          row.strength = score.strength;
          ranked += 1;
        }
      } catch {
        /* assemble still runs; those rows keep the default strength */
      }
    }),
  );
  return { ranked, tokens, calls };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function uniqueClaimKey(raw: string, used: Set<string>): string {
  const base = slug(raw) || 'claim';
  if (!used.has(base)) return base;
  let n = 2;
  let next = `${base.slice(0, 56)}-${n}`;
  while (used.has(next)) {
    n += 1;
    next = `${base.slice(0, 56)}-${n}`;
  }
  return next;
}

export async function deriveSeeds(input: Pick<FactoryInput, 'prompt' | 'taskContext' | 'notes' | 'observed' | 'inputs' | 'model' | 'tagStyle'>): Promise<Seed[]> {
  const style = input.tagStyle ?? 'craft';
  const result = await generateJson({ model: input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL, system: seederSystem(style), parts: contextParts({ ...input, seeds: [] }), schema: Seeds, temperature: 0.4 });
  return result.value.seeds.map((s, i) => ({
    id: `seed-${i + 1}`,
    theme: s.theme.trim(),
    statement: toAffirmativeStatement(s.statement),
    tag: isRubricTag(s.tag) ? aliasTag(s.tag, style) ?? s.tag : undefined,
  }));
}

export async function runFactory(input: FactoryInput): Promise<{ statements: FactoryStatement[]; bank: BankRow[]; report: FactoryReport }> {
  const model = input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL;
  const target = input.target ?? RUBRIC_TARGET;
  const style = input.tagStyle ?? 'craft';
  const quotas = familyQuotas(target);
  let calls = 0;
  let totalTokens = 0;
  const work: FactoryInput = { ...input, tagStyle: style };

  if (work.inputs.length > 0) {
    await input.onStage?.('reading', { files: work.inputs.length });
    const seen = await describeWork(work);
    calls += 1;
    totalTokens += seen.tokens;
    if (seen.account) work.observed = seen.account;
    await input.onStage?.('reading', { files: work.inputs.length, observed: Boolean(seen.account) });
  }

  let seeds = work.seeds.filter((s) => s.statement.trim());
  if (seeds.length === 0 && work.notes?.trim() && shouldExtractNotes(work.notes)) {
    const extracted = extractSeedsFromNotes(work.notes, MAX_SEEDS, style);
    await input.onStage?.('seeding', { source: 'notes', count: extracted.length });
    seeds = extracted.map((s, i) => ({ id: `seed-${i + 1}`, theme: s.theme, statement: s.statement, tag: s.tag }));
  }
  if (seeds.length === 0) {
    await input.onStage?.('seeding', { source: 'model' });
    seeds = await deriveSeeds(work);
    calls += 1;
  }
  const perSeed = enhancerRowsPerSeed(seeds.length, target);
  const thinAt = Math.max(2, Math.floor(perSeed / 2));
  const grounding = enhanceParts(work);

  // Operator seeds are already checks — keep them in the bank so assemble can seat them.
  const bank: BankRow[] = [];
  const usedKeys = new Set<string>();
  for (const seed of seeds) {
    const statement = describeNamedFiles(toAffirmativeStatement(seed.statement));
    const tag = tagOnChannel(statement, seed.tag, style);
    const key = uniqueClaimKey(seed.statement || seed.id, usedKeys);
    bank.push({ seedId: seed.id, claimKey: key, statement, tag, family: familyOfTag(tag), notes: 'expert seed' });
    usedKeys.add(key);
  }

  // ── enhance: a small pool so the first seeds can finish and tick 1/50.
  // Fifty at once used to hang the SDK until the 180s HTTP timeout.
  await input.onStage?.('enhancing', { seeds: seeds.length, perSeed });
  let fatal: GeminiError | undefined;
  await poolMap(seeds, 8, async (seed) => {
      if (fatal) return;
      const system = enhancerSystem(style).replaceAll('{{TARGET_COUNT}}', String(perSeed));
      const parts: (string | MediaPart)[] = [
        ...grounding,
        `=== EXPERT SEED ===\nseed_id: ${seed.id}\ntheme: ${seed.theme}\nsuggested_tag: ${seed.tag ?? '(choose)'}\nstatement: ${seed.statement}`,
        `=== PREVIOUSLY USED claim_keys (do not reuse) ===\n${[...usedKeys].slice(-40).join(', ') || '(none)'}`,
      ];
      try {
        const result = await generateJson({
          model,
          system,
          parts,
          schema: BankRows,
          temperature: 0.5,
          maxOutputTokens: 4096,
          timeoutMs: 90_000,
          structured: false,
        });
        calls += 1;
        totalTokens += result.usage.totalTokens;
        let kept = 0;
        for (const row of result.value.rows) {
          const statement = describeNamedFiles(toAffirmativeStatement(row.statement));
          const tag = tagOnChannel(statement, isRubricTag(row.tag) ? row.tag : seed.tag, style);
          const key = uniqueClaimKey(row.claim_key || row.statement, usedKeys);
          bank.push({ seedId: seed.id, claimKey: key, statement, tag, family: familyOfTag(tag), notes: row.notes.trim() });
          usedKeys.add(key);
          kept += 1;
        }
        await input.onStage?.(kept < thinAt ? 'seed_thin' : 'seed_done', { seed: seed.id, theme: seed.theme, rows: kept });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[factory] seed failed', seed.id, message);
        await input.onStage?.('seed_failed', { seed: seed.id, theme: seed.theme, error: message });
        if (error instanceof GeminiError && (error.kind === 'rate_limit' || error.kind === 'auth')) fatal = error;
      }
  });
  if (fatal) throw fatal;

  // ── rank: score the bank, then assemble seats the strongest distinct claims.
  await input.onStage?.('ranking', { bank: bank.length });
  const ranked = await rankStrength({ model, rows: bank });
  calls += ranked.calls;
  totalTokens += ranked.tokens;

  await input.onStage?.('assembling', { bank: bank.length, ranked: ranked.ranked });
  const assembled = assemble(bank, quotas);

  // ── AI lint, chunks of 15; apply claim-preserving rewrites that pass local lint.
  await input.onStage?.('linting', { seated: assembled.seated.length });
  let aiLintFailures = 0;
  let rewritesApplied = 0;
  const statements: FactoryStatement[] = assembled.seated.map((row) => ({
    family: row.family,
    tag: row.tag,
    statement: row.statement,
    notes: row.notes,
    claimKey: row.claimKey,
    origin: 'factory',
    lint: lintStatement({ statement: row.statement, tag: row.tag }),
    scope: 'output',
    inputFileIds: [],
    outputFile: null,
    strength: row.strength,
  }));
  const linted = await aiLint({
    model,
    taskContext: work.taskContext,
    statements: statements.map((s, i) => ({ id: `r${i + 1}`, statement: s.statement, tag: s.tag })),
    onChunkFailed: (chunk, error) => input.onStage?.('lint_chunk_failed', { chunk, error }),
  });
  calls += linted.calls;
  totalTokens += linted.totalTokens;
  statements.forEach((target, i) => {
    const verdict = linted.results[`r${i + 1}`];
    if (!verdict) return;
    if (verdict.overall === 'pass') {
      if (target.lint.overall === 'pass') target.lint = { ...target.lint, source: 'ai' };
      return;
    }
    aiLintFailures += 1;
    // Apply the rewrite only when it is a wording fix of the same claim.
    const rewrite = verdict.rewriteSuggestion;
    const rewriteOk = rewrite && lintStatement({ statement: rewrite, tag: target.tag }).overall === 'pass' && nearDuplicate(rewrite, target.statement, 0.3);
    if (rewriteOk) {
      rewritesApplied += 1;
      target.statement = toAffirmativeStatement(rewrite);
      target.notes = [target.notes, 'ai-lint rewrite applied'].filter(Boolean).join(' · ');
      target.lint = { overall: 'pass', verdicts: allPass(), reasons: [], rewriteSuggestion: '', source: 'ai' };
    } else {
      target.lint = verdict;
    }
  });

  const inputRefs = input.inputs.map((file) => ({ id: file.id, name: file.name }));
  const outputRefs = input.deliverables ?? [];
  for (const target of statements) {
    const scope = inferFileScope(target.statement, inputRefs, outputRefs);
    target.scope = scope.scope;
    target.inputFileIds = scope.inputFileIds;
    target.outputFile = scope.outputFile;
  }

  const seatedByFamily = countByFamily(statements);
  const report: FactoryReport = {
    seeds: seeds.length,
    bankSize: bank.length,
    droppedByLint: assembled.droppedByLint,
    droppedAsDuplicate: assembled.droppedAsDuplicate,
    seated: statements.length,
    quotas,
    seatedByFamily,
    shortfall: { format: Math.max(0, quotas.format - seatedByFamily.format), content: Math.max(0, quotas.content - seatedByFamily.content), visual: Math.max(0, quotas.visual - seatedByFamily.visual) },
    aiLintFailures,
    rewritesApplied,
    ranked: ranked.ranked,
    observed: Boolean(work.observed),
    model,
    calls,
    totalTokens,
  };
  return { statements, bank, report };
}

/**
 * The 8-attribute LLM lint, in chunks of 15. Returns one LintResult per id
 * (missing ids = the chunk failed; callers keep their previous lint). Used
 * by the factory and by the "Check wording" action on an edited rubric.
 */
export async function aiLint(input: {
  model?: string;
  taskContext: string;
  statements: { id: string; statement: string; tag: string }[];
  onChunkFailed?: (chunk: number, error: string) => Promise<void> | void;
}): Promise<{ results: Record<string, LintResult>; calls: number; totalTokens: number }> {
  const model = input.model ?? env().GEMINI_FACTORY_MODEL ?? env().GEMINI_MODEL;
  const results: Record<string, LintResult> = {};
  let calls = 0;
  let totalTokens = 0;
  const chunks: (typeof input.statements)[] = [];
  for (let i = 0; i < input.statements.length; i += 15) chunks.push(input.statements.slice(i, i + 15));
  await Promise.all(
    chunks.map(async (chunk, chunkIndex) => {
      const list = chunk.map((s) => `${s.id} | ${s.tag} | ${s.statement}`).join('\n');
      try {
        const result = await generateJson({ model, system: LINTER_SYSTEM, parts: [`--- Task context ---\n${input.taskContext}\n\n--- Statements (id | tag | statement) ---\n${list}`], schema: LintRows, temperature: 0.1, maxOutputTokens: 8192 });
        calls += 1;
        totalTokens += result.usage.totalTokens;
        for (const row of result.value.rows) {
          const target = chunk.find((s) => s.id === row.id);
          if (!target) continue;
          if (row.overall === 'pass') {
            results[row.id] = { overall: 'pass', verdicts: allPass(), reasons: [], rewriteSuggestion: '', source: 'ai' };
            continue;
          }
          const verdicts = asVerdicts(row.verdicts);
          const rewrite = (row.rewrite_suggestion?.trim() ?? '').replace(/\?+$/, '');
          results[row.id] = {
            overall: 'fail',
            verdicts,
            reasons: LINT_ATTRIBUTES.filter((a) => verdicts[a] === 'fail').map((a) => `AI lint: ${a}`),
            rewriteSuggestion: rewrite,
            source: 'ai',
          };
        }
      } catch (error) {
        await input.onChunkFailed?.(chunkIndex, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  return { results, calls, totalTokens };
}

function asVerdicts(raw: Record<string, 'pass' | 'fail'> | undefined): LintVerdicts {
  const verdicts = allPass();
  for (const attribute of LINT_ATTRIBUTES) {
    if (raw?.[attribute] === 'fail') verdicts[attribute] = 'fail';
  }
  if (!raw || LINT_ATTRIBUTES.every((a) => verdicts[a] === 'pass')) verdicts.falsifiable = 'fail';
  return verdicts;
}

function countByFamily(rows: { family: Family }[]): Record<Family, number> {
  const counts: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  for (const row of rows) counts[row.family] += 1;
  return counts;
}
