import { describeNamedFiles } from './fileLanguage';
import { FAMILIES, type Family } from './rubric';

/**
 * Compact unused factory-bank row as persisted on rubric.generation.bank.
 * Short keys keep the jsonb payload small (hundreds of unused claims).
 */
export interface CompactBankRow {
  k: string;
  s: string;
  t: string;
  f: Family;
  n: string;
  d: string;
  w?: number;
}

export interface BankCandidate {
  claimKey: string;
  statement: string;
  tag: string;
  family: Family;
  notes: string;
  seedId: string;
  strength?: number;
}

function isFamily(value: unknown): value is Family {
  return typeof value === 'string' && (FAMILIES as readonly string[]).includes(value);
}

/** Reads the compact unused bank stored on a rubric generation blob. */
export function parseBank(generation: Record<string, unknown> | null | undefined): BankCandidate[] {
  if (!generation || typeof generation !== 'object') return [];
  const raw = generation.bank;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is CompactBankRow => {
      if (typeof row !== 'object' || row === null) return false;
      const r = row as CompactBankRow;
      return typeof r.k === 'string' && typeof r.s === 'string';
    })
    .map((r) => ({
      claimKey: r.k,
      statement: describeNamedFiles(r.s),
      tag: r.t ?? '',
      family: isFamily(r.f) ? r.f : 'content',
      notes: r.n ?? '',
      seedId: r.d ?? '',
      strength: typeof r.w === 'number' ? r.w : undefined,
    }));
}

export function compactBankRow(c: BankCandidate): CompactBankRow {
  return { k: c.claimKey, s: c.statement, t: c.tag, f: c.family, n: c.notes, d: c.seedId, ...(c.strength !== undefined ? { w: c.strength } : {}) };
}

/**
 * After a seat is swapped or a bank row is added, drop the newly seated
 * claim from the unused bank and put the displaced wording back so it
 * can be swapped in again.
 */
export function rewriteBank(generation: Record<string, unknown>, seated: BankCandidate, displaced?: BankCandidate | null): Record<string, unknown> {
  const next = parseBank(generation).filter((c) => c.claimKey !== seated.claimKey);
  if (displaced?.claimKey && displaced.claimKey !== seated.claimKey && !next.some((c) => c.claimKey === displaced.claimKey)) {
    next.unshift(displaced);
  }
  return { ...generation, bank: next.map(compactBankRow) };
}
