import { isSoftSeat } from './discrimination';
import { describeNamedFiles } from './fileLanguage';
import { HELPER_CRAFT } from './helperCraft';
import { lintStatement, nearDuplicate } from './lint';
import { isRubricTag, type Family, type RubricTag } from './rubric';

/** §14 buckets. Classify first. Do not rewrite first. */
export type HelperBucket =
  | 'discriminator'
  | 'hygiene'
  | 'rater_noise'
  | 'false_on_golden'
  | 'output_fitted'
  | 'happenstance'
  | 'soft'
  | 'duplicate'
  | 'ungraded';
export type HelperGroundingInput = { prompt: string; inputRoles?: readonly string[] };
export type HelperAction = 'keep' | 'drop' | 'override' | 'rewrite';
export type HelperGrounding = 'prompt' | `input:${string}` | `craft:${string}`;

export interface HelperSeatInput {
  id: string;
  statement: string;
  tag: string;
  family: Family;
  claimKey?: string | null;
  golden: boolean | null;
  goldenEvidence?: string;
  stability: Array<boolean | null>;
  stabilityEvidence?: string[];
}

export interface HelperAnalysisRow extends HelperSeatInput {
  bucket: HelperBucket;
  action: HelperAction;
  reason: string;
  ai: boolean | null;
}

export interface HelperDraft {
  seatId?: string;
  statement: string;
  tag: string;
  grounding: HelperGrounding;
  golden?: boolean | null;
  ai?: boolean | null;
  evidence?: string;
}

export interface HelperPackedRow {
  statement: string;
  tag: RubricTag;
  grounding: HelperGrounding;
  confidence: number;
  evidence: string;
  golden: boolean | null;
  ai: boolean | null;
}

export interface HelperActRow extends HelperAnalysisRow {
  rewrite: string | null;
  confidence: number | null;
  grounding: HelperGrounding | null;
}

export interface HelperMix {
  keep: number;
  act: number;
  add: number;
  predictedGolden: number;
  predictedCalibration: number;
  ready: boolean;
  refuse: string | null;
}

export interface HelperResult {
  keep: HelperAnalysisRow[];
  act: HelperActRow[];
  add: HelperPackedRow[];
  mix: HelperMix;
}

const CHEAT =
  /\b(golden|autorate|ai output|the ai(?:'s)? (?:video|deck|file|deliverable|output)|reference (?:video|deliverable|golden)|as (?:seen|shown|measured) in the (?:golden|ai|reference))\b/i;
const NAMED_FILE =
  /\b(?:the\s+)?[A-Za-z0-9][\w.-]*\.(pptx|ppt|pdf|docx|doc|xlsx|xls|csv|png|jpe?g|webp|gif|svg|heic|psd|mp4|mov|webm|mp3|wav|m4a|zip|html|txt|md)\b/i;
const GENERIC_BAR = /\b(every|across all slides|slide canvas|canvas boundaries|all slides|hierarchy exists|generous clearspace)\b/i;
const RATER_NOISE =
  /\b(96\s*dpi|xres\s*=\s*96|page\s*\/\s*3|equal 99\s*mm|thin column|only a rule|ocean blue|no ocean|sea photo|placed ppi|fold widths?)\b/i;
const HAPPENSTANCE = /\b(unique crop|wraps at|bronze column|this pixel|near-black)\b/i;
const FILE_TELL = /\b(mascot|sofa|this crop)\b/i;
const SLIDE_INDEX = /\bslides?\s+\d+/i;
const REQUIRED_LOCK = /\b(16:9 page size|page size|cta|lockup|exactly as written)\b/i;
const RANK: Record<HelperBucket, number> = {
  output_fitted: 0,
  duplicate: 1,
  false_on_golden: 2,
  rater_noise: 3,
  happenstance: 4,
  soft: 5,
  hygiene: 6,
  ungraded: 7,
  discriminator: 8,
};
const REWRITABLE = new Set<HelperBucket>(['output_fitted', 'false_on_golden', 'soft']);
const FITTED_LOCKED = new Set<HelperBucket>(['output_fitted', 'duplicate', 'happenstance', 'false_on_golden', 'rater_noise']);
const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'that',
  'this',
  'with',
  'uses',
  'use',
  'as',
  'by',
  'at',
  'from',
  'it',
  'be',
  'are',
  'was',
  'were',
  'has',
  'have',
  'its',
  'into',
  'than',
  'then',
  'also',
  'only',
  'each',
  'all',
  'any',
  'not',
  'but',
  'if',
]);
const CRAFT_ANCHOR: Record<string, RegExp> = {
  'slides-canvas': /\b(slide canvas|canvas boundaries|inside the (?:slide )?canvas)\b/i,
  'slides-title-safe': /\btitle[- ]safe\b/i,
  'logo-undistorted': /\b(aspect ratio|undistorted)\b/i,
  'media-undistorted': /\b(original proportions|stretching or squashing|without (?:stretching|squashing))\b/i,
  'live-text': /\blive text\b/i,
  'type-emphasis': /\b(bold and italic|italic styles|emphasize key words)\b/i,
  'video-sync': /\b(in sync with the mouth|lip[- ]sync|speech stays in sync)\b/i,
};

const PROMPT_FIELD = /^(prompt|instruction|brief|task|description)$/i;

/** Catalog stores the designer brief on `task` more often than `prompt`. */
export function promptFromFields(fields: readonly { key: string; text: string }[]): string {
  return fields.find((field) => PROMPT_FIELD.test(field.key) && field.text.trim())?.text.trim() ?? '';
}

export function helperGate(input: {
  hasRubric: boolean;
  goldenGraded: number;
  stabilityPasses: number;
  hasAi: boolean;
  hasPrompt: boolean;
  /** Seats whose golden grade no longer matches their text. */
  goldenStale?: number;
  /** Seats edited since the latest Stability run. */
  stabilityStale?: number;
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const seats = (count: number) => `${count} seat${count === 1 ? '' : 's'}`;
  if (!input.hasRubric) missing.push('Write a few seats first.');
  if (input.goldenGraded < 1) missing.push('Grade the golden file first.');
  else if (input.goldenStale) missing.push(`Re-grade the golden file: ${seats(input.goldenStale)} changed since it was graded.`);
  if (input.stabilityPasses < 1) missing.push('Run Stability so we have an AI grade.');
  else if (input.stabilityStale) missing.push(`Run Stability again: ${seats(input.stabilityStale)} changed since the last run.`);
  if (!input.hasAi) missing.push('Attach the AI output first.');
  if (!input.hasPrompt) missing.push('This task is missing its brief.');
  return { ok: missing.length === 0, missing };
}

/** Stability answers are keyed by seat id, so a seat edited after the group started still carries its old answer. */
export function staleSinceStability(
  statements: readonly { id: string; updatedAt: string | Date }[],
  passes: readonly { answers: Record<string, boolean | null>; createdAt: string | Date }[],
): number {
  if (passes.length === 0) return 0;
  const started = Math.min(...passes.map((pass) => new Date(pass.createdAt).getTime()));
  return statements.filter((row) => new Date(row.updatedAt).getTime() > started || passes.some((pass) => !(row.id in pass.answers))).length;
}

function aiOf(stability: readonly (boolean | null)[]): boolean | null {
  const graded = stability.filter((value): value is boolean => value === true || value === false);
  if (graded.length === 0) return null;
  return graded.every((value) => value === true);
}

function isGenericBar(statement: string): boolean {
  return GENERIC_BAR.test(statement) || isSoftSeat({ statement });
}

function isRequiredHygiene(row: Pick<HelperSeatInput, 'statement' | 'family'>): boolean {
  if (isGenericBar(row.statement) && !REQUIRED_LOCK.test(row.statement)) return false;
  return row.family === 'format' || REQUIRED_LOCK.test(row.statement);
}

function looksHappenstance(statement: string, prompt: string): boolean {
  if (HAPPENSTANCE.test(statement)) return true;
  if (/\bbronze\b/i.test(statement) && !/\bbronze\b/i.test(prompt)) return true;
  return false;
}

function hexesOf(text: string): string[] {
  return [...text.toLowerCase().matchAll(/#[0-9a-f]{3,8}\b/g)].map((match) => match[0]);
}

function looksFileSpecific(statement: string, prompt: string): boolean {
  if (FILE_TELL.test(statement)) return true;
  if (SLIDE_INDEX.test(statement) && !SLIDE_INDEX.test(prompt)) return true;
  return hexesOf(statement).some((hex) => !prompt.toLowerCase().includes(hex));
}

function looksRaterNoise(seat: HelperSeatInput): boolean {
  return RATER_NOISE.test(seat.statement) || RATER_NOISE.test(seat.goldenEvidence ?? '') || (seat.stabilityEvidence ?? []).some((line) => RATER_NOISE.test(line));
}

function significantTokens(text: string): { words: Set<string>; locks: Set<string> } {
  const words = new Set<string>();
  const locks = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/\d+:\d+|#[0-9a-f]{3,8}|\b[a-z][a-z0-9-]{3,}\b/g)) {
    const token = match[0];
    if (/\d+:\d+|#[0-9a-f]{3,8}/.test(token)) locks.add(token);
    else if (!STOP.has(token)) words.add(token);
  }
  return { words, locks };
}

function promptOverlap(statement: string, prompt: string): boolean {
  if (!prompt.trim()) return false;
  const left = significantTokens(statement);
  const right = significantTokens(prompt);
  for (const lock of left.locks) {
    if (right.locks.has(lock)) return true;
  }
  let hits = 0;
  for (const word of left.words) {
    if (right.words.has(word)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function craftOf(statement: string): HelperGrounding | null {
  const lower = statement.toLowerCase();
  for (const [id, phrase] of Object.entries(HELPER_CRAFT)) {
    if (nearDuplicate(statement, phrase) || lower.includes(phrase.toLowerCase())) return `craft:${id}`;
    if (CRAFT_ANCHOR[id]?.test(statement)) return `craft:${id}`;
  }
  return null;
}

function inputOf(statement: string, roles: readonly string[]): HelperGrounding | null {
  const lower = statement.toLowerCase();
  for (const role of [...roles].toSorted((a, b) => b.length - a.length)) {
    const trimmed = role.trim();
    if (trimmed.length >= 3 && lower.includes(trimmed.toLowerCase())) return `input:${trimmed}`;
  }
  return null;
}

export function seatGroundingOf(statement: string, grounding: HelperGroundingInput): HelperGrounding | null {
  const inputRoles = grounding.inputRoles ?? [];
  if (looksCheated(statement, { prompt: grounding.prompt, inputRoles })) return null;
  const craft = craftOf(statement);
  if (craft) return craft;
  const namedInput = inputOf(statement, inputRoles);
  if (namedInput) return namedInput;
  if (promptOverlap(statement, grounding.prompt)) return 'prompt';
  return null;
}

export function analyzeHelperSeats(seats: readonly HelperSeatInput[], grounding: HelperGroundingInput = { prompt: '' }): HelperAnalysisRow[] {
  const rows = seats.map((seat) => {
    const ai = aiOf(seat.stability);
    let bucket: HelperBucket = 'ungraded';
    let action: HelperAction = 'keep';
    let reason = 'This seat has not been graded on the golden file or this AI pack yet.';
    const dup = seats.some((other) => other.id !== seat.id && (other.claimKey && seat.claimKey && other.claimKey === seat.claimKey || nearDuplicate(other.statement, seat.statement)));
    if (seat.golden === null && ai === null) {
      bucket = 'ungraded';
      action = 'keep';
      reason = 'This seat has not been graded on the golden file or this AI pack yet.';
    } else if (dup) {
      bucket = 'duplicate';
      action = 'drop';
      reason = 'This says the same thing as another seat. Drop one of them.';
    } else if (looksRaterNoise(seat)) {
      bucket = 'rater_noise';
      action = 'override';
      reason = 'The grade looks like a measurement glitch. Keep the wording and override the grade from the file.';
    } else if (seat.golden === false) {
      bucket = 'false_on_golden';
      action = 'rewrite';
      reason = 'This failed on the golden file. Reword it so it is true, or drop it. Do not mark a false seat as yes.';
    } else if (seat.golden === true && ai === false && looksHappenstance(seat.statement, grounding.prompt)) {
      bucket = 'happenstance';
      action = 'drop';
      reason = 'This is true on this golden file, but the brief did not ask for it. Drop it unless an input required it.';
    } else if (seat.golden === true && isSoftSeat({ statement: seat.statement }) && !REQUIRED_LOCK.test(seat.statement)) {
      bucket = 'soft';
      action = 'rewrite';
      reason = 'This is too vague. Use a number, ratio, locked line, or named color from the brief. If none exists, drop it.';
    } else if (seat.golden === true && ai === true && isGenericBar(seat.statement) && !isRequiredHygiene(seat)) {
      bucket = 'hygiene';
      action = 'drop';
      reason = 'Both the golden file and this AI pack already pass this. It is too easy — drop it.';
    } else if (seat.golden === true && ai === true) {
      bucket = 'hygiene';
      action = 'keep';
      reason = 'Both files pass this. Keep it only if the brief requires it (page size, locked line, named type).';
    } else if (seat.golden === true && ai === false) {
      const origin = { prompt: grounding.prompt, inputRoles: grounding.inputRoles ?? [] };
      if (looksCheated(seat.statement, origin) || looksFileSpecific(seat.statement, grounding.prompt)) {
        bucket = 'output_fitted';
        action = 'rewrite';
        reason = 'This seat is written off the golden or AI file, not the brief, an input, or a named craft implicit. Retarget it — or drop it.';
      } else {
        bucket = 'discriminator';
        action = 'keep';
        reason = 'The golden file passes and this AI pack fails. Keep this seat as written.';
      }
    } else {
      bucket = 'ungraded';
      action = 'keep';
      reason = 'This seat has not been graded on the golden file or this AI pack yet.';
    }
    return { ...seat, bucket, action, reason, ai };
  });
  return rankHelperRows(rows);
}

export function shouldScanForFitted(row: HelperAnalysisRow, grounding: HelperGroundingInput): boolean {
  if (row.golden !== true || row.ai !== false || row.action !== 'keep') return false;
  const origin = seatGroundingOf(row.statement, grounding);
  return !origin?.startsWith('craft:') && !origin?.startsWith('input:');
}

export function applyFittedScan(rows: readonly HelperAnalysisRow[], fittedIds: readonly string[]): HelperAnalysisRow[] {
  const flagged = new Set(fittedIds);
  return rankHelperRows(
    rows.map((row) => {
      if (!flagged.has(row.id) || FITTED_LOCKED.has(row.bucket)) return row;
      if (row.bucket === 'hygiene' && row.action === 'drop') return row;
      if (seatGroundingOf(row.statement, { prompt: '' })?.startsWith('craft:')) return row;
      return {
        ...row,
        bucket: 'output_fitted' as const,
        action: 'rewrite' as const,
        reason: 'This seat reads as written off the golden or AI file, not the brief, an input, or a named craft implicit. Retarget it — or drop it.',
      };
    }),
  );
}

function rankHelperRows<T extends { bucket: HelperBucket; statement: string }>(rows: readonly T[]): T[] {
  return rows.toSorted((a, b) => RANK[a.bucket] - RANK[b.bucket] || a.statement.localeCompare(b.statement));
}

export function looksCheated(statement: string, grounding: { prompt: string; inputRoles: readonly string[] }): boolean {
  const cleaned = describeNamedFiles(statement);
  if (NAMED_FILE.test(statement) || NAMED_FILE.test(cleaned)) return true;
  if (CHEAT.test(statement) || CHEAT.test(cleaned)) return true;
  void grounding;
  return false;
}

export function helperConfidence(input: {
  grounding: HelperGrounding;
  golden: boolean | null;
  ai: boolean | null;
  lintPass: boolean;
  digestRatable: boolean;
  cheated: boolean;
}): number {
  if (input.cheated) return 0;
  let score = 0;
  if (input.grounding === 'prompt') score += 25;
  else if (input.grounding.startsWith('input:')) score += 20;
  else score += 12;
  if (input.golden !== null && input.ai !== null) score += 25;
  if (input.golden === true) score += 20;
  if (input.ai === false) score += 15;
  if (input.lintPass) score += 10;
  if (input.digestRatable) score += 5;
  if (input.golden === null) score = Math.min(score, 40);
  if (!input.digestRatable) score = Math.min(score, 70);
  return score;
}

function asTag(tag: string): RubricTag | null {
  return isRubricTag(tag) ? tag : null;
}

function mixOf(kept: { golden: boolean | null; ai: boolean | null }[], added: { golden: boolean | null; ai: boolean | null }[]): HelperMix {
  const rows = [...kept, ...added];
  const gradedGolden = rows.filter((row) => row.golden === true || row.golden === false);
  const goldenYes = gradedGolden.filter((row) => row.golden === true).length;
  const gradedAi = rows.filter((row) => row.ai === true || row.ai === false);
  const aiYes = gradedAi.filter((row) => row.ai === true).length;
  const predictedGolden = gradedGolden.length === 0 ? 0 : (goldenYes / gradedGolden.length) * 100;
  const predictedCalibration = gradedAi.length === 0 ? 0 : (aiYes / gradedAi.length) * 100;
  let refuse: string | null = null;
  if (predictedGolden < 100) refuse = 'Do not take this whole batch. A seat still fails the golden file. If the file is right, change the grade. If the seat is wrong, reword or drop it.';
  else if (predictedCalibration >= 40) refuse = 'Too many seats would still pass this AI pack. Drop the easy ones both files already pass. Only add something the golden file has and the AI missed.';
  else if (predictedCalibration < 20) refuse = 'Too few seats would pass this AI pack. Add a required lock from the brief — page size, typeface, or a locked line — until more of them pass both.';
  return {
    keep: 0,
    act: 0,
    add: 0,
    predictedGolden,
    predictedCalibration,
    ready: refuse === null && gradedGolden.length > 0,
    refuse,
  };
}

export function packHelperResult(input: {
  seats: readonly HelperSeatInput[];
  prompt: string;
  inputRoles: readonly string[];
  drafts?: readonly HelperDraft[];
  fittedIds?: readonly string[];
}): HelperResult {
  const analyzed = applyFittedScan(analyzeHelperSeats(input.seats, { prompt: input.prompt, inputRoles: input.inputRoles }), input.fittedIds ?? []);
  const seatedTexts = analyzed.map((row) => row.statement);
  const accepted: HelperPackedRow[] = [];
  const rewriteBySeat = new Map<string, HelperPackedRow>();
  const grounding = { prompt: input.prompt, inputRoles: input.inputRoles };

  for (const draft of input.drafts ?? []) {
    const tag = asTag(draft.tag);
    const statement = describeNamedFiles(draft.statement).trim();
    if (!tag || statement.length < 8) continue;
    const lint = lintStatement({ statement, tag });
    const cheated = looksCheated(statement, grounding);
    if (lint.overall !== 'pass' || cheated || looksFileSpecific(statement, input.prompt)) continue;
    if (!draft.grounding) continue;
    if (isGenericBar(statement)) continue;
    if (seatedTexts.some((text) => nearDuplicate(text, statement)) || accepted.some((row) => nearDuplicate(row.statement, statement))) {
      continue;
    }
    const row: HelperPackedRow = {
      statement,
      tag,
      grounding: draft.grounding,
      confidence: helperConfidence({
        grounding: draft.grounding,
        golden: draft.golden ?? null,
        ai: draft.ai ?? null,
        lintPass: true,
        digestRatable: true,
        cheated: false,
      }),
      evidence: (draft.evidence ?? '').trim(),
      golden: draft.golden ?? null,
      ai: draft.ai ?? null,
    };
    if (draft.seatId) {
      const seat = analyzed.find((item) => item.id === draft.seatId);
      if (!seat || !REWRITABLE.has(seat.bucket)) continue;
      if (row.golden === false) continue;
      rewriteBySeat.set(draft.seatId, row);
    } else if (row.golden === true && row.ai === false) {
      accepted.push(row);
    }
  }

  const keep: HelperAnalysisRow[] = [];
  const act: HelperActRow[] = [];
  for (const row of analyzed) {
    if (row.action === 'keep' && row.bucket !== 'ungraded') {
      keep.push(row);
      continue;
    }
    if (row.action === 'keep') continue;
    const rewrite = rewriteBySeat.get(row.id);
    act.push({
      ...row,
      rewrite: rewrite?.statement ?? null,
      confidence: rewrite?.confidence ?? null,
      grounding: rewrite?.grounding ?? null,
    });
  }

  keep.sort((a, b) => (a.bucket === 'discriminator' ? 0 : 1) - (b.bucket === 'discriminator' ? 0 : 1));
  const add = accepted.toSorted((a, b) => b.confidence - a.confidence);
  const predictedRows = [
    ...keep.map((row) => ({ golden: row.golden, ai: row.ai })),
    ...act.flatMap((row) => {
      if (row.action === 'drop') return [];
      if (row.action === 'override') return [{ golden: true as const, ai: row.ai }];
      if (row.rewrite) return [{ golden: true as const, ai: rewriteBySeat.get(row.id)?.ai ?? row.ai }];
      return [{ golden: row.golden, ai: row.ai }];
    }),
    ...add.map((row) => ({ golden: row.golden, ai: row.ai })),
  ];
  const mix = mixOf(predictedRows, []);
  mix.keep = keep.length;
  mix.act = act.length;
  mix.add = add.length;
  return { keep, act, add, mix };
}

export function isHelperGrounding(value: string): value is HelperGrounding {
  return value === 'prompt' || value.startsWith('input:') || value.startsWith('craft:');
}

export function helperResultOf(raw: unknown): HelperResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.keep) || !Array.isArray(value.act) || !Array.isArray(value.add) || !value.mix || typeof value.mix !== 'object') return null;
  return value as unknown as HelperResult;
}
