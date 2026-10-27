import { BOARD_STATES, WORK_STATE_LABEL, type WorkState } from '@/domain/workState';

/** How the "Your seats" panel should group held work. */
export type SeatPanelKind = 'reviewer' | 'rubric' | 'both';

export type SeatGroup<T> = {
  state: WorkState;
  label: string;
  rows: T[];
};

export type OrganizedSeats<T> = {
  kind: SeatPanelKind;
  /** Active review seats — always shown expanded when non-empty. */
  needsAction: T[];
  /** Reviewer-only: every non–in-review seat, shown collapsed. */
  earlier: T[];
  /** Rubric / dual: non-empty status groups (board order). */
  groups: SeatGroup<T>[];
};

/** Board order minus Unassigned (held seats are never unassigned). */
const RUBRIC_GROUP_ORDER = BOARD_STATES.filter((s) => s !== 'unassigned');

export function seatPanelKind(caps: { canReview: boolean; canCreateRubrics: boolean }): SeatPanelKind {
  if (caps.canReview && caps.canCreateRubrics) return 'both';
  if (caps.canReview) return 'reviewer';
  return 'rubric';
}

/** Reviewers act on In review; everything else is prior work parked below. */
export function partitionReviewerSeats<T extends { workState: WorkState }>(rows: T[]): {
  needsAction: T[];
  earlier: T[];
} {
  const needsAction: T[] = [];
  const earlier: T[] = [];
  for (const row of rows) {
    if (row.workState === 'in_review') needsAction.push(row);
    else earlier.push(row);
  }
  return { needsAction, earlier };
}

/** Rubric creators: one collapsible per non-empty work state, board order. */
export function groupRubricSeats<T extends { workState: WorkState }>(rows: T[]): SeatGroup<T>[] {
  const byState = new Map<WorkState, T[]>();
  for (const row of rows) {
    const list = byState.get(row.workState);
    if (list) list.push(row);
    else byState.set(row.workState, [row]);
  }
  return RUBRIC_GROUP_ORDER.flatMap((state) => {
    const groupRows = byState.get(state);
    if (!groupRows?.length) return [];
    return [{ state, label: WORK_STATE_LABEL[state], rows: groupRows }];
  });
}

export function organizeMySeats<T extends { workState: WorkState }>(
  rows: T[],
  kind: SeatPanelKind,
): OrganizedSeats<T> {
  if (kind === 'reviewer') {
    const { needsAction, earlier } = partitionReviewerSeats(rows);
    return { kind, needsAction, earlier, groups: [] };
  }
  if (kind === 'rubric') {
    return { kind, needsAction: [], earlier: [], groups: groupRubricSeats(rows) };
  }
  const { needsAction, earlier } = partitionReviewerSeats(rows);
  return { kind, needsAction, earlier: [], groups: groupRubricSeats(earlier) };
}
