import {
  canCreateRubrics,
  canOversee,
  canReview,
  type Actor,
  type SeatCaps,
} from '@/lib/auth/permissions';

export const WORK_MODE_COOKIE = 'gdp_work_mode';

export const WORK_MODES = ['rubric', 'review'] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export type { SeatCaps };

export function parseWorkMode(raw: string | null | undefined): WorkMode {
  return raw === 'review' ? 'review' : 'rubric';
}

/** Dual non-overseer accounts pick one hat at a time on the home board. */
export function usesWorkMode(actor: Actor): boolean {
  return canCreateRubrics(actor) && canReview(actor) && !canOversee(actor);
}

/**
 * Caps for claim queue / seat panel. Dual accounts are narrowed by mode;
 * everyone else keeps their real permissions (mode ignored).
 */
export function effectiveCaps(actor: Actor, mode: WorkMode): SeatCaps {
  if (!usesWorkMode(actor)) {
    return { canCreateRubrics: canCreateRubrics(actor), canReview: canReview(actor) };
  }
  if (mode === 'review') return { canCreateRubrics: false, canReview: true };
  return { canCreateRubrics: true, canReview: false };
}

/** Held seats for the active hat; otherHatCount drives the switch nudge. */
export function seatsForMode<T extends { rubricAssigneeId: string | null; reviewerId: string | null }>(
  rows: T[],
  actorId: string,
  mode: WorkMode,
): { visible: T[]; otherHatCount: number } {
  const visible: T[] = [];
  let otherHatCount = 0;
  for (const row of rows) {
    const holdsRubric = row.rubricAssigneeId === actorId;
    const holdsReview = row.reviewerId === actorId;
    if (mode === 'rubric') {
      if (holdsRubric) visible.push(row);
      else if (holdsReview) otherHatCount += 1;
    } else if (holdsReview) {
      visible.push(row);
    } else if (holdsRubric) {
      otherHatCount += 1;
    }
  }
  return { visible, otherHatCount };
}
