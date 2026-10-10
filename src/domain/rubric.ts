/**
 * The rubric contract. Pure; shared by server, worker and browser.
 *
 * A statement is an affirmative Precise Boolean: "Yes" means the desired
 * state holds. Polarity is never configurable — the factory rejects
 * negative-as-desired wording and the lint flags it.
 */
export const FAMILIES = ['format', 'content', 'visual'] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABELS: Record<Family, string> = {
  format: 'Format/File',
  content: 'Content',
  visual: 'Visual',
};

export const RUBRIC_TAGS = [
  'Format/File',
  'Content - Exact',
  'Content - Structural',
  'Content - Semantics',
  'Content - Quantitative',
  'Visual - Branding',
  'Visual - Layout',
  'Visual - Consistency',
  'Visual - Balance/Density',
  'Visual - Language & Readability',
] as const;
export type RubricTag = (typeof RUBRIC_TAGS)[number];

export const TAG_FAMILY: Record<RubricTag, Family> = {
  'Format/File': 'format',
  'Content - Exact': 'content',
  'Content - Structural': 'content',
  'Content - Semantics': 'content',
  'Content - Quantitative': 'content',
  'Visual - Branding': 'visual',
  'Visual - Layout': 'visual',
  'Visual - Consistency': 'visual',
  'Visual - Balance/Density': 'visual',
  'Visual - Language & Readability': 'visual',
};

export function familyOfTag(tag: string): Family {
  return TAG_FAMILY[tag as RubricTag] ?? 'content';
}

export function isRubricTag(tag: string): tag is RubricTag {
  return (RUBRIC_TAGS as readonly string[]).includes(tag);
}

/** Standard target and the 10% / 30% / 60% family split (5 / 15 / 30 at 50). */
export const RUBRIC_TARGET = 50;
export const RUBRIC_MIN = 40;

/** Upper bound on operator-supplied expert seeds per generation (one enhancer call each). */
export const MAX_SEEDS = 100;
export const MAX_SEED_CHARS = 600;
/** Pasted notes / question lists. Every distinct check becomes a seed (capped at MAX_SEEDS). */
export const MAX_ROUGH_CHARS = 50_000;

export function familyQuotas(n: number = RUBRIC_TARGET): Record<Family, number> {
  const format = Math.max(3, Math.round((n * 5) / 50));
  const content = Math.max(10, Math.round((n * 15) / 50));
  let visual = n - format - content;
  if (visual < 18) {
    const bump = 18 - visual;
    const fromContent = Math.min(bump, Math.max(0, content - 10));
    visual += fromContent;
    return { format, content: content - fromContent, visual };
  }
  return { format, content, visual };
}

export type StatementScope = 'output' | 'inputs';

/** The editable shape of one seat. Mirrors app.rubric_statements. */
export interface StatementDraft {
  id: string;
  position: number;
  family: Family;
  tag: string;
  statement: string;
  notes: string;
  scope: StatementScope;
  inputFileIds: string[];
  outputFile: string | null;
  claimKey: string | null;
}

/** Delivered row id: `s001`, `s002`, … in display order. */
export const deliveryId = (index: number): string => `s${String(index + 1).padStart(3, '0')}`;

const FAMILY_DISPLAY: Family[] = ['format', 'content', 'visual'];

export interface SeatRef {
  id: string;
  family?: Family;
  tag?: string;
  position?: number;
}

/** Format 1–5, Content 6–20, Visual 21–50 — one number the whole team shares. */
export function seatsInDisplayOrder<T extends SeatRef>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const fa = FAMILY_DISPLAY.indexOf(a.family ?? familyOfTag(a.tag ?? ''));
    const fb = FAMILY_DISPLAY.indexOf(b.family ?? familyOfTag(b.tag ?? ''));
    if (fa !== fb) return fa - fb;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

export function seatIndexById(rows: readonly SeatRef[]): Map<string, number> {
  const map = new Map<string, number>();
  seatsInDisplayOrder(rows).forEach((row, index) => map.set(row.id, index + 1));
  return map;
}

export function seatLabel(n: number | undefined): string {
  return typeof n === 'number' && n > 0 ? `Seat ${n}` : 'Seat';
}

/** Swap raw statement ids (uuid or s001) in operator-facing copy for "Seat 8". */
export function withSeatLabels(text: string, seats: Map<string, number>): string {
  let out = text;
  for (const [id, n] of seats) {
    if (id && out.includes(id)) out = out.split(id).join(seatLabel(n));
    const delivered = deliveryId(n - 1);
    if (out.includes(delivered)) out = out.split(delivered).join(seatLabel(n));
  }
  return out;
}
