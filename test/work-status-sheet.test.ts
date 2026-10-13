import { describe, expect, it } from 'vitest';
import {
  catalogIdFromTaskCell,
  findStatusRubricsUpdate,
  findWorkStatusSheetUpdates,
  shouldPushWorkSheet,
  shouldPushWorkStatus,
  WORK_STATUS_SHEET_LABELS,
  workStatusSheetOwner,
} from '@/domain/workStatusSheet';

describe('shouldPushWorkStatus', () => {
  it('writes only when the board label changes', () => {
    expect(shouldPushWorkStatus('unassigned', 'unassigned')).toBe(false);
    expect(shouldPushWorkStatus('unassigned', 'preparing')).toBe(true);
    expect(shouldPushWorkStatus(null, 'unassigned')).toBe(true);
  });
});

describe('catalogIdFromTaskCell', () => {
  const id = '22c685ba-9465-4fe4-83a9-d984fba972fa';

  it('reads a pasted Catalog UUID, including from a Wirestock URL', () => {
    expect(catalogIdFromTaskCell(id)).toBe(id);
    expect(catalogIdFromTaskCell(`https://wirestock.io/submissions/${id}`)).toBe(id);
    expect(catalogIdFromTaskCell('54dd7011')).toBe(null);
    expect(catalogIdFromTaskCell('')).toBe(null);
  });
});

describe('findStatusRubricsUpdate', () => {
  const id = '80bba201-5c64-4ec4-a347-e549d3de26b1';
  const rows = [
    ['Task Writer', 'Task ID', 'Wirestock status', 'Staus Rubrics', 'Assignee'],
    ['Ada', id, 'K.Golden Output Approved', 'Preparing', 'Rubric Team'],
    ['Bea', '', 'C. Task Review', '', ''],
    ['Cal', `https://wirestock.io/?id=${id.toUpperCase()}`, 'H2. Golden Output Ready for Review', 'Other', ''],
  ];

  it('patches Status Rubrics on the row that already has that UUID', () => {
    expect(findStatusRubricsUpdate(rows, id, 'Unassigned')).toEqual({
      rowIndex: 1,
      columnIndex: 3,
      value: 'Unassigned',
    });
  });

  it('does not invent a row when the UUID is not on the sheet', () => {
    expect(findStatusRubricsUpdate(rows, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Preparing')).toBe(null);
  });

  it('writes Staus Rubrics Team on the live PM tracker header', () => {
    const live = [
      [
        'Job Title',
        'Industry',
        'Deliverable Details',
        'Details',
        'PM',
        'Task Writer',
        'Deadline',
        'Golden Output Creator',
        'Expert',
        'Task ID',
        'Distractor?',
        'Wirestock status',
        'Date sent to Rubrics',
        'Staus Rubrics Team',
        'Assignee',
        'Date Returned',
        'Task ID short',
      ],
      ['', '', '', '', '', '', '', '', '', id, '', 'K.Golden Output Approved', '', '', 'Ada', '', '80bba201'],
    ];
    expect(findStatusRubricsUpdate(live, id, 'Unassigned')).toEqual({
      rowIndex: 1,
      columnIndex: 13,
      value: 'Unassigned',
    });
  });
});

describe('workStatusSheetOwner', () => {
  it('writes the platform name for the person who currently owns the piece', () => {
    expect(workStatusSheetOwner('preparing', { rubric: 'Pietro', reviewer: null })).toBe('Pietro');
    expect(workStatusSheetOwner('in_review', { rubric: 'Pietro', reviewer: 'Jakub' })).toBe('Jakub');
    expect(workStatusSheetOwner('unassigned', { rubric: null, reviewer: null })).toBe('Rubric Team');
    expect(workStatusSheetOwner('in_review', { rubric: 'Pietro', reviewer: null })).toBe('Review Team');
  });
});

describe('shouldPushWorkSheet', () => {
  it('writes when the owner changes even if the board status does not', () => {
    expect(shouldPushWorkSheet({ state: 'preparing', owner: 'Pietro' }, { state: 'preparing', owner: 'Vahan' })).toBe(true);
    expect(shouldPushWorkSheet({ state: 'preparing', owner: 'Pietro' }, { state: 'preparing', owner: 'Pietro' })).toBe(false);
  });
});

describe('findWorkStatusSheetUpdates', () => {
  const id = '80bba201-5c64-4ec4-a347-e549d3de26b1';
  const live = [
    [
      'Job Title',
      'Industry',
      'Deliverable Details',
      'Details',
      'PM',
      'Task Writer',
      'Deadline',
      'Golden Output Creator',
      'Expert',
      'Task ID',
      'Distractor?',
      'Wirestock status',
      'Date sent to Rubrics',
      'Staus Rubrics Team',
      'Assignee',
      'Date Returned',
      'Task ID short',
    ],
    ['', '', '', '', '', '', '', '', '', id, '', 'K.Golden Output Approved', '', 'Preparing', 'Rubric Team', '', '80bba201'],
  ];

  it('patches Status Rubrics and Assignee on the matching row', () => {
    expect(findWorkStatusSheetUpdates(live, id, { status: 'In review', owner: 'Jakub' })).toEqual([
      { rowIndex: 1, columnIndex: 13, value: 'In review' },
      { rowIndex: 1, columnIndex: 14, value: 'Jakub' },
    ]);
  });
});

describe('sheet dropdown labels', () => {
  it('lists the nine GDP board statuses', () => {
    expect(WORK_STATUS_SHEET_LABELS).toEqual([
      'Unassigned',
      'Preparing',
      'In review',
      'Review returned',
      'Approved',
      'Ready to submit',
      'Platform returned',
      'Submitted',
      'Other',
    ]);
  });
});
