import type { Role } from '@/db/schema';

/**
 * Roles are permission bundles, not personas; a user may hold several.
 *
 *   admin           everything, including Settings (users and watched projects)
 *   pm              same task visibility as admin; seats, unlock, handoff;
 *                   no Settings
 *   rubric_creator  claims the next rubric task blind; then brief, files,
 *                   Golden, bank, stability; no history, no Settings
 *   reviewer        claims a review task by its id and rubric creator; then scores the seated
 *                   rubric; no Golden, jobs log, or Settings
 */
export interface Actor {
  id: string;
  email: string;
  displayName: string | null;
  roles: ReadonlySet<Role>;
  isActive: boolean;
}

export const has = (actor: Actor, ...roles: Role[]): boolean => roles.some((r) => actor.roles.has(r));

export const isAdmin = (a: Actor) => has(a, 'admin');
export const isController = (a: Actor) => has(a, 'admin', 'pm');
export const canCreateRubrics = (a: Actor) => has(a, 'admin', 'pm', 'rubric_creator');
export const canReview = (a: Actor) => has(a, 'admin', 'pm', 'reviewer');
export const canManageUsers = (a: Actor) => has(a, 'admin');
export const canManageProjects = (a: Actor) => has(a, 'admin', 'pm');

export interface SeatView {
  rubricAssigneeId: string | null;
  reviewerId: string | null;
  stage?: string;
}

/** What the task page is allowed to show this actor. Controllers see everything. */
export type TaskLens = 'controller' | 'rubric' | 'reviewer';

export function taskLens(actor: Actor, seat: SeatView): TaskLens {
  if (isController(actor)) return 'controller';
  if (holdsRubricSeat(actor, seat)) return 'rubric';
  if (holdsReviewSeat(actor, seat)) return 'reviewer';
  if (canCreateRubrics(actor) && canReview(actor)) return seat.stage === 'review' ? 'reviewer' : 'rubric';
  if (canReview(actor) && !canCreateRubrics(actor)) return 'reviewer';
  if (canCreateRubrics(actor)) return 'rubric';
  return 'reviewer';
}

export function maySeeGoldenFiles(actor: Actor, seat: SeatView): boolean {
  return taskLens(actor, seat) !== 'reviewer';
}

/** May this actor edit the rubric / run Golden / Stability / push? */
export function holdsRubricSeat(actor: Actor, seat: SeatView): boolean {
  return isController(actor) || (seat.rubricAssigneeId !== null && seat.rubricAssigneeId === actor.id);
}

/** Admin, PM, or the seated rubric creator — Golden and Stability can be re-run at any stage. */
export function canRunStability(actor: Actor, seat: SeatView): boolean {
  return holdsRubricSeat(actor, seat);
}

/** AI output files may change only in rubric. Empty seat is fine for admin/PM. */
export function canChangeAiOutputs(actor: Actor, seat: SeatView): boolean {
  if (seat.stage !== 'rubric') return false;
  return holdsRubricSeat(actor, seat);
}

/** May this actor perform the human AI evaluation and decide the review? */
export function holdsReviewSeat(actor: Actor, seat: SeatView): boolean {
  return isController(actor) || (seat.reviewerId !== null && seat.reviewerId === actor.id);
}

/** May this actor read the record at all? Unclaimed work is not visible — they claim it blind. */
export function canSeeSubmission(actor: Actor, seat: SeatView): boolean {
  if (isController(actor)) return true;
  if (seat.rubricAssigneeId === actor.id) return true;
  if (seat.reviewerId === actor.id) return true;
  return false;
}

/** Which seat this actor may take without seeing the brief. Null if it is not theirs to claim. */
export function claimableSeat(actor: Actor, seat: SeatView): 'rubric' | 'review' | null {
  if (seat.stage === 'review' && seat.reviewerId === null && canReview(actor)) return 'review';
  if (seat.stage !== 'review' && seat.rubricAssigneeId === null && canCreateRubrics(actor)) return 'rubric';
  return null;
}
