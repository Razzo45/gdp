import { isSoftSeat } from './discrimination';
import { describeNamedFiles } from './fileLanguage';
import { lintStatement, nearDuplicate } from './lint';
import { isRubricTag, type Family, type RubricTag } from './rubric';

/** §14 buckets. Classify first. Do not rewrite first. */
export type HelperBucket =
  | 'discriminator'
  | 'hygiene'
  | 'rater_noise'
  | 'false_on_golden'
  | 'happenstance'
  | 'soft'
  | 'duplicate'
  | 'ungraded';
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
const REQUIRED_LOCK = /\b(16:9 page size|page size|cta|lockup|exactly as written)\b/i;
const RANK: Record<HelperBucket, number> = {
  false_on_golden: 0,
  rater_noise: 1,
  happenstance: 2,
  duplicate: 3,
  soft: 4,
  hygiene: 5,
  ungraded: 6,
  discriminator: 7,
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
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!input.hasRubric) missing.push('Write a rubric first.');
  if (input.goldenGraded < 1) missing.push('Run Golden first.');
  if (input.stabilityPasses < 1) missing.push('Grade this AI pack first (run Stability).');
  if (!input.hasAi) missing.push('Attach the AI output first.');
  if (!input.hasPrompt) missing.push('The task needs a prompt.');
  return { ok: missing.length === 0, missing };
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

function looksRaterNoise(seat: HelperSeatInput): boolean {
  return RATER_NOISE.test(seat.statement) || RATER_NOISE.test(seat.goldenEvidence ?? '') || (seat.stabilityEvidence ?? []).some((line) => RATER_NOISE.test(line));
}

export function analyzeHelperSeats(seats: readonly HelperSeatInput[], grounding: { prompt: string } = { prompt: '' }): HelperAnalysisRow[] {
  const rows = seats.map((seat) => {
    const ai = aiOf(seat.stability);
    let bucket: HelperBucket = 'ungraded';
    let action: HelperAction = 'keep';
    let reason = 'Not graded on Golden or this AI pack yet.';
    const dup = seats.some((other) => other.id !== seat.id && (other.claimKey && seat.claimKey && other.claimKey === seat.claimKey || nearDuplicate(other.statement, seat.statement)));
    if (seat.golden === null && ai === null) {
      bucket = 'ungraded';
      action = 'keep';
      reason = 'Not graded on Golden or this AI pack yet.';
    } else if (dup) {
      bucket = 'duplicate';
      action = 'drop';
      reason = 'Same claim as another seat. Tags do not make a duplicate legal.';
    } else if (looksRaterNoise(seat)) {
      bucket = 'rater_noise';
      action = 'override';
      reason = 'Known rater-noise family. Keep the claim. Override with the disk measure. Do not weaken it.';
    } else if (seat.golden === false) {
      bucket = 'false_on_golden';
      action = 'rewrite';
      reason = 'False on Golden. Reword to a grounded form that is true on disk, or drop. Never Yes a false lock.';
    } else if (seat.golden === true && ai === false && looksHappenstance(seat.statement, grounding.prompt)) {
      bucket = 'happenstance';
      action = 'drop';
      reason = 'True only because this golden did it. Drop unless the prompt or an input required it.';
    } else if (seat.golden === true && isSoftSeat({ statement: seat.statement }) && !REQUIRED_LOCK.test(seat.statement)) {
      bucket = 'soft';
      action = 'rewrite';
      reason = 'Soft wording. Replace the taste word with the input’s own number, ratio, locked line, or named colour. If none exists, drop.';
    } else if (seat.golden === true && ai === true && isGenericBar(seat.statement) && !isRequiredHygiene(seat)) {
      bucket = 'hygiene';
      action = 'drop';
      reason = 'Yes on Golden and Yes on this AI pack. Soft hygiene lifts calibration. Drop it. Do not add more canvas or generic contrast.';
    } else if (seat.golden === true && ai === true) {
      bucket = 'hygiene';
      action = 'keep';
      reason = 'Yes on both. Keep only as a required brief lock (canvas size, locked CTA, named type).';
    } else if (seat.golden === true && ai === false) {
      bucket = 'discriminator';
      action = 'keep';
      reason = 'True on Golden, false on this AI pack, and seated. Keep. Do not soften it.';
    } else {
      bucket = 'ungraded';
      action = 'keep';
      reason = 'Not graded on Golden or this AI pack yet.';
    }
    return { ...seat, bucket, action, reason, ai };
  });
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
  if (predictedGolden < 100) refuse = 'This batch still has a false Golden lock. Measure. If true, override. If false, reword or drop. Never Yes a false lock.';
  else if (predictedCalibration >= 40) refuse = 'Predicted calibration is still 40 or higher. Drop Yes-both hygiene. Add only measured Golden-Yes / AI-No claims. Do not spray visual seats.';
  else if (predictedCalibration < 20) refuse = 'Predicted calibration is under 20. Add required both-Yes locks from the brief (canvas, typeface, locked line) until the mix sits in 20–50.';
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
}): HelperResult {
  const analyzed = analyzeHelperSeats(input.seats, { prompt: input.prompt });
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
    if (lint.overall !== 'pass' || cheated) continue;
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
      if (!seat || (seat.bucket !== 'false_on_golden' && seat.bucket !== 'soft')) continue;
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
