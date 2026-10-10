/**
 * Deterministic structural lint. Ported from the play-by-play reference.
 *
 * This layer only judges form: interrogatives, time-bound words, stacked
 * claims, defect-as-desired-state, unknown tags. Taste (FALSIFIABLE,
 * UNIVERSAL) is the LLM linter's job. Local failures are BLOCKING for
 * factory output and WARNINGS for human-authored edits — humans own their
 * wording, but they are told.
 */
import { isRubricTag } from './rubric';

export const LINT_ATTRIBUTES = [
  'falsifiable',
  'universal',
  'unambiguous',
  'self_contained',
  'non_stacked',
  'timeless',
  'expected_yes',
  'file_addressed_present',
] as const;
export type LintAttribute = (typeof LINT_ATTRIBUTES)[number];
export type LintVerdicts = Record<LintAttribute, 'pass' | 'fail'>;

export interface LintResult {
  overall: 'pass' | 'fail';
  verdicts: LintVerdicts;
  reasons: string[];
  /** Set by the LLM linter; local lint leaves it empty. */
  rewriteSuggestion: string;
  source: 'local' | 'ai';
}

export const INTERROGATIVE_OPENER =
  /^(does|do|is|are|can|will|has|have|should|would|could|was|were|did)\b/i;

const TIMELESS_BAD =
  /\b(recent(ly)?|current(ly)?|as of today|trending|up[- ]to[- ]date|latest|this (year|month|week)|20[2-9]\d)\b/i;

const STACKED_PHRASE = /\b(and also|as well as|in addition to|along with)\b/i;

const NEGATIVE_YES =
  /\b(has|have|contains?|shows?|includes?|exhibits?|displays?)\s+(a |an |the |any |some |visible |obvious |noticeable )?(clutter|errors?|typos?|artifacts?|distortion|clipping|overlap(ping)?|misalign(ment|ed)|defects?|glitch(es)?|blur|noise|watermarks?|placeholder|lorem ipsum|broken)\b/i;

const HARD_FRAMING = /\b(free of|rather than|instead of|without|no more than|at most|at least|exactly|matches?|consistent with)\b/i;

export function allPass(): LintVerdicts {
  return {
    falsifiable: 'pass',
    universal: 'pass',
    unambiguous: 'pass',
    self_contained: 'pass',
    non_stacked: 'pass',
    timeless: 'pass',
    expected_yes: 'pass',
    file_addressed_present: 'pass',
  };
}

export function looksLikeInterrogative(text: string): boolean {
  const q = text.trim();
  if (!q) return false;
  if (/\?\s*$/.test(q)) return true;
  return INTERROGATIVE_OPENER.test(q);
}

/** Strip a trailing ? and interrogative opener so pasted questions land as statements. */
export function toAffirmativeStatement(raw: string): string {
  let s = raw.trim().replace(/\?+$/g, '').trim();
  s = s.replace(INTERROGATIVE_OPENER, '').trim();
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!]$/.test(s)) s += '.';
  return s;
}

function stripQuoted(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g, '""');
}

function looksStacked(q: string): boolean {
  if (STACKED_PHRASE.test(q)) return true;
  if (/\b(and|but)\s+(does|do|is|are|has|have|the)\b/i.test(q)) return true;
  if (/;\s*(does|do|is|are|has|have|the)\b/i.test(q)) return true;
  return false;
}

export function lintStatement(input: { statement: string; tag: string }): LintResult {
  const q = (input.statement ?? '').trim();
  const verdicts = allPass();
  const reasons: string[] = [];

  if (q === '') {
    verdicts.unambiguous = 'fail';
    reasons.push('statement is empty');
  }
  if (looksLikeInterrogative(q)) {
    verdicts.unambiguous = 'fail';
    reasons.push('must be an affirmative statement, not a question (no "?", no Does/Is/Are… opener)');
  }
  if (TIMELESS_BAD.test(stripQuoted(q))) {
    verdicts.timeless = 'fail';
    reasons.push('time-bound wording (recent/current/latest/year)');
  }
  if (looksStacked(q)) {
    verdicts.non_stacked = 'fail';
    reasons.push('looks like two testable claims joined together — split into two statements');
  }
  if (
    NEGATIVE_YES.test(q) &&
    !/\b(free of|without|no |zero |absent|not )\b/i.test(q) &&
    !HARD_FRAMING.test(q) &&
    !/\b(error messages?|error (?:color|text|state|styling)|validation errors?)\b/i.test(q) &&
    !/\bpass\s*\/\s*fail\b/i.test(q)
  ) {
    verdicts.expected_yes = 'fail';
    reasons.push('phrase so that Yes means the good outcome (e.g. "The slide is free of clutter.")');
  }
  if (input.tag && !isRubricTag(input.tag)) {
    verdicts.unambiguous = 'fail';
    reasons.push(`unknown tag "${input.tag}"`);
  }

  const overall = Object.values(verdicts).every((v) => v === 'pass') ? 'pass' : 'fail';
  return { overall, verdicts, reasons, rewriteSuggestion: '', source: 'local' };
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9#\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard over word tokens (length > 2). Used to rank bank alternatives. */
export function tokenJaccard(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** Jaccard over word shingles; ≥ 0.72 is treated as a paraphrase. */
export function nearDuplicate(a: string, b: string, threshold = 0.72): boolean {
  return tokenJaccard(a, b) >= threshold;
}
