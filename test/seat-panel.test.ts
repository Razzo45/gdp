import { describe, expect, it } from 'vitest';
import { groupRubricSeats, organizeMySeats, partitionReviewerSeats, seatPanelKind } from '@/domain/seatPanel';
import type { WorkState } from '@/domain/workState';

const row = (id: string, workState: WorkState) => ({ id, workState });

describe('partitionReviewerSeats', () => {
  it('keeps In review on top and parks everything else as earlier', () => {
    const rows = [row('a', 'submitted'), row('b', 'in_review'), row('c', 'submitted'), row('d', 'handoff')];
    expect(partitionReviewerSeats(rows)).toEqual({
      needsAction: [row('b', 'in_review')],
      earlier: [row('a', 'submitted'), row('c', 'submitted'), row('d', 'handoff')],
    });
  });

  it('allows an empty needs-action list when the reviewer only holds finished seats', () => {
    expect(partitionReviewerSeats([row('a', 'submitted')])).toEqual({
      needsAction: [],
      earlier: [row('a', 'submitted')],
    });
  });
});

describe('groupRubricSeats', () => {
  it('groups by work state, skips empty groups, and keeps board order', () => {
    const rows = [row('s', 'submitted'), row('p', 'preparing'), row('r', 'review_returned'), row('s2', 'submitted')];
    expect(groupRubricSeats(rows)).toEqual([
      { state: 'preparing', label: 'Preparing', rows: [row('p', 'preparing')] },
      { state: 'review_returned', label: 'Review returned', rows: [row('r', 'review_returned')] },
      { state: 'submitted', label: 'Submitted', rows: [row('s', 'submitted'), row('s2', 'submitted')] },
    ]);
  });

  it('hides every group when there are no seats', () => {
    expect(groupRubricSeats([])).toEqual([]);
  });
});

describe('seatPanelKind', () => {
  it('uses the reviewer split for review-only accounts', () => {
    expect(seatPanelKind({ canReview: true, canCreateRubrics: false })).toBe('reviewer');
  });

  it('uses status groups for rubric-only creators', () => {
    expect(seatPanelKind({ canReview: false, canCreateRubrics: true })).toBe('rubric');
  });

  it('reports both when caps are un-narrowed; dual home passes effectiveCaps so only one hat shows', () => {
    expect(seatPanelKind({ canReview: true, canCreateRubrics: true })).toBe('both');
    expect(seatPanelKind({ canReview: false, canCreateRubrics: true })).toBe('rubric');
    expect(seatPanelKind({ canReview: true, canCreateRubrics: false })).toBe('reviewer');
  });
});

describe('organizeMySeats', () => {
  it('for reviewers, pins In review and collapses the rest', () => {
    const rows = [row('a', 'submitted'), row('b', 'in_review')];
    expect(organizeMySeats(rows, 'reviewer')).toEqual({
      kind: 'reviewer',
      needsAction: [row('b', 'in_review')],
      earlier: [row('a', 'submitted')],
      groups: [],
    });
  });

  it('for rubric creators, returns only non-empty status groups', () => {
    const rows = [row('a', 'submitted'), row('b', 'preparing')];
    expect(organizeMySeats(rows, 'rubric')).toEqual({
      kind: 'rubric',
      needsAction: [],
      earlier: [],
      groups: [
        { state: 'preparing', label: 'Preparing', rows: [row('b', 'preparing')] },
        { state: 'submitted', label: 'Submitted', rows: [row('a', 'submitted')] },
      ],
    });
  });

  it('for dual-role, pins In review then groups the rest by status', () => {
    const rows = [row('a', 'submitted'), row('b', 'in_review'), row('c', 'preparing')];
    expect(organizeMySeats(rows, 'both')).toEqual({
      kind: 'both',
      needsAction: [row('b', 'in_review')],
      earlier: [],
      groups: [
        { state: 'preparing', label: 'Preparing', rows: [row('c', 'preparing')] },
        { state: 'submitted', label: 'Submitted', rows: [row('a', 'submitted')] },
      ],
    });
  });
});
