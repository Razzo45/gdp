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

export function workStatusSheetLabel(state: WorkState): string {
  return WORK_STATE_LABEL[state];
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

/** First sheet row that already has this Catalog UUID. Never invents a row. */
export function findStatusRubricsUpdate(
  rows: readonly (readonly string[])[],
  catalogId: string,
  value: string,
): StatusRubricsUpdate | null {
  const id = catalogIdFromTaskCell(catalogId);
  if (!id || rows.length === 0) return null;
  const header = rows[0] ?? [];
  const taskCol = headerIndex(header, 'task id');
  const statusCol = headerIndex(header, 'status rubrics', 'staus rubrics', 'staus rubrics team');
  if (taskCol < 0 || statusCol < 0) return null;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    if (catalogIdFromTaskCell(rows[rowIndex]?.[taskCol]) === id) {
      return { rowIndex, columnIndex: statusCol, value };
    }
  }
  return null;
}
