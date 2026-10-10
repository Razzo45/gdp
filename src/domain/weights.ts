/**
 * Percentage shares for seated rows. A Yes earns that share; a No earns
 * none; unanswered stay out of the live score. Displayed weights always
 * sum to 100%.
 */

export const RUBRIC_WEIGHT_TOTAL = 100;

export interface WeightedRow {
  weight?: number | null;
}

export interface SeatedRow {
  answer?: boolean | null;
  weight?: number | null;
}

export interface SeatScore {
  passed: number;
  failed: number;
  outstanding: number;
  graded: number;
  total: number;
  passedWeight: number;
  failedWeight: number;
  outstandingWeight: number;
  gradedWeight: number;
  totalWeight: number;
  /** passedWeight / gradedWeight; 0 when nothing is graded. */
  fraction: number;
  /** Band the final fraction lands in once every seat is answered. */
  floor: number;
  ceiling: number;
}

const finiteWeight = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1;

const rounded = (value: number): number => Math.round(value * 100) / 100;

function roundToTotal(values: number[]): number[] {
  const result = values.map(rounded);
  const last = result.length - 1;
  if (last < 0) return result;
  const correction = rounded(RUBRIC_WEIGHT_TOTAL - result.reduce((sum, value) => sum + value, 0));
  result[last] = rounded(Math.max(0, result[last]! + correction));
  return result;
}

/** Display and scoring weights whose total is exactly 100%. Pass a count for equal shares. */
export function normalisedWeights(rows: number | readonly WeightedRow[]): number[] {
  const list: WeightedRow[] = typeof rows === 'number' ? Array.from({ length: rows }, () => ({ weight: 1 })) : [...rows];
  if (list.length === 0) return [];
  const raw = list.map((row) => finiteWeight(row.weight));
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total === 0) return roundToTotal(list.map(() => RUBRIC_WEIGHT_TOTAL / list.length));
  return roundToTotal(raw.map((value) => (value / total) * RUBRIC_WEIGHT_TOTAL));
}

export function scoreSeats(rows: readonly SeatedRow[]): SeatScore {
  let passed = 0;
  let failed = 0;
  let outstanding = 0;
  let passedWeight = 0;
  let failedWeight = 0;
  let outstandingWeight = 0;
  const weights = normalisedWeights(rows);

  for (const [index, row] of rows.entries()) {
    const weight = weights[index]!;
    if (row.answer === true) {
      passed += 1;
      passedWeight += weight;
    } else if (row.answer === false) {
      failed += 1;
      failedWeight += weight;
    } else {
      outstanding += 1;
      outstandingWeight += weight;
    }
  }

  const graded = passed + failed;
  const gradedWeight = passedWeight + failedWeight;
  const scorableWeight = gradedWeight + outstandingWeight;

  return {
    passed,
    failed,
    outstanding,
    graded,
    total: rows.length,
    passedWeight,
    failedWeight,
    outstandingWeight,
    gradedWeight,
    totalWeight: weights.reduce((sum, weight) => sum + weight, 0),
    fraction: gradedWeight === 0 ? 0 : passedWeight / gradedWeight,
    floor: scorableWeight === 0 ? 0 : passedWeight / scorableWeight,
    ceiling: scorableWeight === 0 ? 0 : (passedWeight + outstandingWeight) / scorableWeight,
  };
}

export function formatWeight(value: number): string {
  return `${value.toFixed(1)}%`;
}
