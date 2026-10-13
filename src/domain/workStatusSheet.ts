import { BOARD_STATES, WORK_STATE_LABEL, type WorkState } from './workState';

/** Dropdown / cell values we write into Status Rubrics. Order matches the board chips. */
export const WORK_STATUS_SHEET_LABELS = BOARD_STATES.map((state) => WORK_STATE_LABEL[state]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function catalogIdFromTaskCell(value: string | null | undefined): string | null {
  const match = String(value ?? '').match(UUID);
  return match ? match[0]!.toLowerCase() : null;
}

export function shouldPushWorkStatus(previous: WorkState | null, next: WorkState): boolean {
  return previous !== next;
}

export function shouldPushWorkSheet(
  previous: { state: WorkState; owner: string } | null,
  next: { state: WorkState; owner: string },
): boolean {
  if (!previous) return true;
  return previous.state !== next.state || previous.owner !== next.owner;
}

export function workStatusSheetLabel(state: WorkState): string {
  return WORK_STATE_LABEL[state];
}

/** Same owner the PM board shows: reviewer while In review, else the rubric holder. */
export function workStatusSheetOwner(
  state: WorkState,
  names: { rubric: string | null; reviewer: string | null },
): string {
  if (state === 'in_review') return names.reviewer?.trim() || 'Review Team';
  const rubric = names.rubric?.trim() || '';
  if (rubric) return rubric;
  if (state === 'unassigned' || state === 'preparing' || state === 'review_returned') return 'Rubric Team';
  return '';
}

export interface StatusRubricsUpdate {
  rowIndex: number;
  columnIndex: number;
  value: string;
}

function headerIndex(header: readonly string[], ...needles: string[]): number {
  const names = header.map((cell) =>
    String(cell ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  );
  for (const needle of needles) {
    const exact = names.findIndex((name) => name === needle);
    if (exact >= 0) return exact;
  }
  return names.findIndex((name) => needles.some((needle) => name.includes(needle) && name !== 'task id short'));
}

function locateTaskRow(rows: readonly (readonly string[])[], catalogId: string): {
  rowIndex: number;
  statusCol: number;
  ownerCol: number;
} | null {
  const id = catalogIdFromTaskCell(catalogId);
  if (!id || rows.length === 0) return null;
  const header = rows[0] ?? [];
  const taskCol = headerIndex(header, 'task id');
  const statusCol = headerIndex(header, 'status rubrics', 'staus rubrics', 'staus rubrics team');
  if (taskCol < 0 || statusCol < 0) return null;
  const ownerCol = headerIndex(header, 'assignee', 'owner');
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    if (catalogIdFromTaskCell(rows[rowIndex]?.[taskCol]) === id) {
      return { rowIndex, statusCol, ownerCol };
    }
  }
  return null;
}

/** First sheet row that already has this Catalog UUID. Never invents a row. */
export function findStatusRubricsUpdate(
  rows: readonly (readonly string[])[],
  catalogId: string,
  value: string,
): StatusRubricsUpdate | null {
  const found = locateTaskRow(rows, catalogId);
  if (!found) return null;
  return { rowIndex: found.rowIndex, columnIndex: found.statusCol, value };
}

export function findWorkStatusSheetUpdates(
  rows: readonly (readonly string[])[],
  catalogId: string,
  values: { status: string; owner?: string | null },
): StatusRubricsUpdate[] {
  const found = locateTaskRow(rows, catalogId);
  if (!found) return [];
  const patches: StatusRubricsUpdate[] = [{ rowIndex: found.rowIndex, columnIndex: found.statusCol, value: values.status }];
  if (found.ownerCol >= 0 && values.owner != null && values.owner !== '') {
    patches.push({ rowIndex: found.rowIndex, columnIndex: found.ownerCol, value: values.owner });
  }
  return patches;
}
