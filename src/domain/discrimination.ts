import type { Family } from './rubric';

/** Strength scores below this are treated as soft — mediocre work would pass. */
export const SOFT_STRENGTH = 40;

const TASTE =
  /\b(professional|polished|cohesive|modern|high-quality|appropriate|appealing|engaging|attractive|well[- ]designed|clean look|good|nice)\b/i;
const PRESENCE = /\b(is present|are present|appears|includes? a |has a (title|logo|header|footer)|contains? a )\b/i;
const HARD =
  /\b(exactly|at most|at least|no more than|hex|#|px|%|matches?|free of|rather than|instead of|consistent with)\b/i;

export function isSoftSeat(input: { statement: string; strength?: number }): boolean {
  if (HARD.test(input.statement)) return (input.strength ?? 50) < 25;
  if (typeof input.strength === 'number') return input.strength < SOFT_STRENGTH;
  return TASTE.test(input.statement) || PRESENCE.test(input.statement);
}

export interface DiscriminationRow {
  claimKey: string;
  statement: string;
  family: Family;
  strength?: number;
}

export interface TightenHint {
  claimKey: string;
  statement: string;
  strength?: number;
  replacement?: { claimKey: string; statement: string; strength?: number };
}

export interface DiscriminationReport {
  softCount: number;
  hints: TightenHint[];
}

/** After generate: which seated rows are soft, and a harder unused bank claim if one exists. */
export function analyzeDiscrimination(seated: readonly DiscriminationRow[], bank: readonly DiscriminationRow[]): DiscriminationReport {
  const soft = seated.filter(isSoftSeat);
  const taken = new Set(seated.map((row) => row.claimKey));
  const hints: TightenHint[] = [];
  for (const row of soft) {
    const better = [...bank]
      .filter((candidate) => candidate.family === row.family && !taken.has(candidate.claimKey) && !isSoftSeat(candidate) && (candidate.strength ?? 50) > (row.strength ?? 50))
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0];
    hints.push({
      claimKey: row.claimKey,
      statement: row.statement,
      strength: row.strength,
      replacement: better ? { claimKey: better.claimKey, statement: better.statement, strength: better.strength } : undefined,
    });
    if (better) taken.add(better.claimKey);
    if (hints.length >= 8) break;
  }
  return { softCount: soft.length, hints };
}

export function seatedStrengthOf(generation: Record<string, unknown> | null | undefined): Record<string, number> {
  const raw = generation?.['seatedStrength'];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

export function discriminationOf(generation: Record<string, unknown> | null | undefined): DiscriminationReport | null {
  const raw = generation?.['discrimination'];
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as DiscriminationReport;
  if (typeof report.softCount !== 'number' || !Array.isArray(report.hints)) return null;
  return report;
}
