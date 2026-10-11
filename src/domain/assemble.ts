import { lintStatement, looksLikeInterrogative, nearDuplicate } from './lint';
import { correctTag, familyOfTag, type Family } from './rubric';

/** A candidate row produced by expanding one expert seed. */
export interface BankRow {
  seedId: string;
  claimKey: string;
  statement: string;
  tag: string;
  family: Family;
  notes: string;
  /** 0–100 from the strength-rank pass. Higher = more discriminative. */
  strength?: number;
}

export interface AssembleResult {
  seated: BankRow[];
  droppedByLint: number;
  droppedAsDuplicate: number;
}

/**
 * Deterministic seating:
 *  1. drop rows failing local lint;
 *  2. collapse duplicate claim keys and near-duplicate wording (Jaccard ≥ 0.72);
 *  3. within each seed, prefer higher strength (discriminative checks over soft ones);
 *  4. fill family quotas round-robin across seeds so every expert concern is covered;
 *  5. if a family cannot fill, give its seats to the others (visual first);
 *  6. if still short of the quota total, seat remaining tagged rows (lint-soft last).
 */
export function assemble(bank: BankRow[], quotas: Record<Family, number>): AssembleResult {
  let droppedByLint = 0;
  let droppedAsDuplicate = 0;
  const clean: BankRow[] = [];
  const soft: BankRow[] = [];
  const keys = new Set<string>();
  const tagged = (row: BankRow): BankRow | null => {
    const statement = row.statement.trim();
    if (statement.length < 8 || looksLikeInterrogative(statement)) return null;
    const tag = correctTag(statement, row.tag);
    return { ...row, statement, tag, family: familyOfTag(tag) };
  };
  for (const raw of bank) {
    const row = tagged(raw);
    if (!row) {
      droppedByLint += 1;
      continue;
    }
    if (keys.has(row.claimKey) || [...clean, ...soft].some((kept) => nearDuplicate(kept.statement, row.statement))) {
      droppedAsDuplicate += 1;
      continue;
    }
    keys.add(row.claimKey);
    if (lintStatement({ statement: row.statement, tag: row.tag }).overall === 'pass') clean.push(row);
    else {
      droppedByLint += 1;
      soft.push(row);
    }
  }

  const byStrength = (a: BankRow, b: BankRow) => (b.strength ?? 50) - (a.strength ?? 50);
  const target = quotas.format + quotas.content + quotas.visual;

  const seated = new Set<BankRow>();
  const take = (family: Family | null, n: number, poolRows: BankRow[]): number => {
    const groups = new Map<string, BankRow[]>();
    for (const row of poolRows) {
      if (seated.has(row)) continue;
      if (family && row.family !== family) continue;
      groups.set(row.seedId, [...(groups.get(row.seedId) ?? []), row]);
    }
    const pool = [...groups.values()].map((rows) => rows.sort(byStrength));
    let taken = 0;
    while (taken < n && pool.some((g) => g.length)) {
      for (const group of pool) {
        if (taken >= n) break;
        const next = group.shift();
        if (next) {
          seated.add(next);
          taken += 1;
        }
      }
    }
    return taken;
  };

  const order: Family[] = ['visual', 'content', 'format'];
  let spare = 0;
  for (const family of order) spare += quotas[family] - take(family, quotas[family], clean);
  for (const family of order) {
    if (spare <= 0) break;
    spare -= take(family, spare, clean);
  }
  if (seated.size < target) take(null, target - seated.size, clean);
  if (seated.size < target) take(null, target - seated.size, soft);
  return { seated: [...seated], droppedByLint, droppedAsDuplicate };
}
