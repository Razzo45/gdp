import { describeNamedFiles } from './fileLanguage';
import { lintStatement, looksLikeInterrogative, nearDuplicate } from './lint';
import { correctTag, countFamilies, familyOfTag, quotaTolerance, type Family } from './rubric';

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
 *  6. if still short of the quota total, seat remaining tagged rows (lint-soft last);
 *  7. use the 2-seat quota slack to seat clearly stronger rows from another family.
 */
export function assemble(bank: BankRow[], quotas: Record<Family, number>): AssembleResult {
  let droppedByLint = 0;
  let droppedAsDuplicate = 0;
  const clean: BankRow[] = [];
  const soft: BankRow[] = [];
  const keys = new Set<string>();
  const tagged = (row: BankRow): BankRow | null => {
    const statement = describeNamedFiles(row.statement.trim());
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
  leanTowardStronger(seated, clean, quotas, byStrength);
  return { seated: [...seated], droppedByLint, droppedAsDuplicate };
}

/** Strength points a leftover row must beat a seated row by before it takes that seat from another family. */
const SWAP_MARGIN = 10;

/**
 * Step 7: spend the 2-seat quota slack on strength. Swap the weakest seat of
 * one family for a clearly stronger leftover row of another, while the split
 * stays within tolerance and no seed loses its last seat.
 */
function leanTowardStronger(seated: Set<BankRow>, clean: BankRow[], quotas: Record<Family, number>, byStrength: (a: BankRow, b: BankRow) => number): void {
  const families: Family[] = ['format', 'content', 'visual'];
  const tolerance = quotaTolerance(families.reduce((sum, family) => sum + quotas[family], 0));
  const strength = (row: BankRow) => row.strength ?? 50;
  const moved = () => {
    const counts = countFamilies([...seated]);
    return families.reduce((sum, family) => sum + Math.max(0, quotas[family] - counts[family]), 0);
  };
  while (moved() < tolerance) {
    const counts = countFamilies([...seated]);
    const seedSeats = new Map<string, number>();
    for (const row of seated) seedSeats.set(row.seedId, (seedSeats.get(row.seedId) ?? 0) + 1);
    const leftovers = clean.filter((row) => !seated.has(row)).sort(byStrength);
    const removable = [...seated].filter((row) => (seedSeats.get(row.seedId) ?? 0) > 1).sort((a, b) => byStrength(b, a));
    let best: { add: BankRow; drop: BankRow } | null = null;
    for (const add of leftovers) {
      const drop = removable.find((row) => row.family !== add.family && strength(add) - strength(row) >= SWAP_MARGIN);
      if (!drop) continue;
      const after = { ...counts, [add.family]: counts[add.family] + 1, [drop.family]: counts[drop.family] - 1 };
      const afterMoved = families.reduce((sum, family) => sum + Math.max(0, quotas[family] - after[family]), 0);
      if (afterMoved > tolerance) continue;
      if (!best || strength(add) - strength(drop) > strength(best.add) - strength(best.drop)) best = { add, drop };
    }
    if (!best) return;
    seated.delete(best.drop);
    seated.add(best.add);
  }
}
