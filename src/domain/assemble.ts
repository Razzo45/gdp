import { lintStatement, nearDuplicate } from './lint';
import type { Family } from './rubric';

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
 *  5. if a family cannot fill, give its seats to the others (visual first).
 */
export function assemble(bank: BankRow[], quotas: Record<Family, number>): AssembleResult {
  let droppedByLint = 0;
  let droppedAsDuplicate = 0;
  const clean: BankRow[] = [];
  const keys = new Set<string>();
  for (const row of bank) {
    if (lintStatement({ statement: row.statement, tag: row.tag }).overall !== 'pass') {
      droppedByLint += 1;
      continue;
    }
    if (keys.has(row.claimKey) || clean.some((kept) => nearDuplicate(kept.statement, row.statement))) {
      droppedAsDuplicate += 1;
      continue;
    }
    keys.add(row.claimKey);
    clean.push(row);
  }

  const byStrength = (a: BankRow, b: BankRow) => (b.strength ?? 50) - (a.strength ?? 50);

  const seated = new Set<BankRow>();
  const take = (family: Family, n: number): number => {
    const groups = new Map<string, BankRow[]>();
    for (const row of clean) {
      if (row.family !== family || seated.has(row)) continue;
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
  for (const family of order) spare += quotas[family] - take(family, quotas[family]);
  for (const family of order) {
    if (spare <= 0) break;
    spare -= take(family, spare);
  }
  return { seated: [...seated], droppedByLint, droppedAsDuplicate };
}
