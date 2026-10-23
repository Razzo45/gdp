import { describe, expect, it } from 'vitest';
import { activityRows, deliveryRows, replayTask, summarizeDelivery, type ReportEvent } from '@/domain/reports';

const A = 'creator-a';
const R = 'reviewer-r';
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const ev = (action: string, actorId: string | null, createdAt: string, detail: Record<string, unknown> = {}): ReportEvent => ({ action, actorId, createdAt, detail });

describe('replayTask', () => {
  it('times every state a delivered task went through and counts the round trips', () => {
    const timeline = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(5, 0)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('rubric_claimed', A, at(1, 2)),
        ev('golden_graded', A, at(1, 5)),
        ev('sent_to_review', A, at(1, 12)),
        ev('review_claimed', R, at(1, 14)),
        ev('review_changes_requested', R, at(1, 20)),
        ev('sent_to_review', A, at(1, 22)),
        ev('review_approved', R, at(2, 4)),
        ev('stability_accepted', A, at(2, 6)),
        ev('pushed_to_catalog', A, at(2, 8)),
      ],
    });
    expect(timeline.transitions.map((t) => t.to)).toEqual(['unassigned', 'preparing', 'review_queue', 'in_review', 'review_returned', 'in_review', 'stability', 'handoff', 'submitted']);
    expect(timeline.hoursByState).toMatchObject({ unassigned: 2, preparing: 10, review_queue: 2, in_review: 12, review_returned: 2, stability: 2, handoff: 2 });
    expect(timeline.totalHours).toBe(32);
    expect(timeline.submittedAt).toBe(at(2, 8));
    expect(timeline.reviewRounds).toBe(2);
    expect(timeline.reviewReturns).toBe(1);
    expect(timeline.platformReturns).toBe(0);
    expect(timeline.segments.find((s) => s.state === 'preparing')?.holderId).toBe(A);
    expect(timeline.segments.filter((s) => s.state === 'in_review').map((s) => s.holderId)).toEqual([R, R]);
  });

  it('keeps the clock running on an open task', () => {
    const timeline = replayTask({ landedAt: at(1, 0), now: Date.parse(at(3, 2)), events: [ev('landed', null, at(1, 0))] });
    expect(timeline.totalHours).toBe(50);
    expect(timeline.submittedAt).toBeNull();
    expect(timeline.segments).toEqual([{ state: 'unassigned', enteredAt: at(1, 0), leftAt: null, hours: 50, holderId: null, timed: true }]);
  });

  it('follows an approval that skips Stability straight to handoff', () => {
    const timeline = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(2, 0)),
      events: [ev('landed', null, at(1, 0)), ev('rubric_claimed', A, at(1, 1)), ev('sent_to_review', A, at(1, 2)), ev('review_claimed', R, at(1, 3)), ev('review_approved', R, at(1, 4), { stage: 'handoff' })],
    });
    expect(timeline.transitions.at(-1)?.to).toBe('handoff');
    expect(timeline.hoursByState.stability).toBe(0);
  });

  it('restarts the clock when the Catalog returns a submitted task, without counting time spent submitted', () => {
    const timeline = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(4, 6)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('rubric_claimed', A, at(1, 0)),
        ev('sent_to_review', A, at(1, 4)),
        ev('review_claimed', R, at(1, 4)),
        ev('review_approved', R, at(1, 6)),
        ev('stability_accepted', A, at(1, 8)),
        ev('pushed_to_catalog', A, at(1, 10)),
        ev('catalog_returned', null, at(4, 0), { rubricAssigneeId: A }),
      ],
    });
    expect(timeline.transitions.at(-1)).toMatchObject({ from: 'submitted', to: 'platform_returned', rubricHolderId: A });
    expect(timeline.hoursByState.submitted).toBe(62);
    expect(timeline.totalHours).toBe(16);
    expect(timeline.submittedAt).toBeNull();
    expect(timeline.platformReturns).toBe(1);
  });
});

describe('recovered tasks', () => {
  const recovered = replayTask({
    landedAt: at(1, 0),
    now: Date.parse(at(5, 0)),
    events: [ev('landed', null, at(1, 0)), ev('pipeline_recovered', null, at(3, 0), { from: 'parked', to: { stage: 'done', reviewStatus: 'approved', handoffStatus: 'client_visible' } })],
  });

  it('lands a catch-up recovery in the state it restored and flags the history', () => {
    expect(recovered.transitions.at(-1)).toMatchObject({ from: 'unassigned', to: 'submitted', action: 'pipeline_recovered' });
    expect(recovered.recovered).toBe(true);
  });

  it('does not time what happened before the recovery, nor count it towards time to submit', () => {
    const summary = summarizeDelivery([recovered]);
    expect(summary).toMatchObject({ tasks: 1, recovered: 1, submitted: 0, open: 0, medianHoursToSubmit: null });
    expect(summary.averageHoursByState.unassigned).toBe(0);
  });

  it('stops the clock when the Catalog marks a task done outside the platform', () => {
    const done = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(5, 0)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('pipeline_recovered', null, at(1, 0), { from: 'parked', to: { stage: 'stability', reviewStatus: 'approved', handoffStatus: null } }),
        ev('catalog_marked_done', null, at(1, 6)),
      ],
    });
    expect(done.transitions.at(-1)).toMatchObject({ from: 'stability', to: 'submitted' });
    expect(done.hoursByState.stability).toBe(6);
  });

  it('still times the work done on the platform after a recovery', () => {
    const resumed = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(4, 0)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('pipeline_recovered', null, at(2, 0), { from: 'parked', to: { stage: 'review', reviewStatus: 'pending', handoffStatus: null } }),
        ev('review_claimed', R, at(3, 0)),
      ],
    });
    expect(resumed.hoursByState).toMatchObject({ unassigned: 0, review_queue: 24, in_review: 24 });
    expect(resumed.totalHours).toBe(48);
    const summary = summarizeDelivery([resumed]);
    expect(summary).toMatchObject({ open: 1, recovered: 1 });
    expect(summary.reviewers.get(R)).toMatchObject({ reviewHours: 24, openNow: 1 });
  });
});

describe('summarizeDelivery', () => {
  const delivered = replayTask({
    landedAt: at(1, 0),
    now: Date.parse(at(5, 0)),
    events: [
      ev('landed', null, at(1, 0)),
      ev('rubric_claimed', A, at(1, 2)),
      ev('sent_to_review', A, at(1, 12)),
      ev('review_claimed', R, at(1, 14)),
      ev('review_changes_requested', R, at(1, 20)),
      ev('sent_to_review', A, at(1, 22)),
      ev('review_approved', R, at(2, 4)),
      ev('stability_accepted', A, at(2, 6)),
      ev('pushed_to_catalog', A, at(2, 8)),
    ],
  });
  const stuck = replayTask({ landedAt: at(2, 0), now: Date.parse(at(5, 0)), events: [ev('landed', null, at(2, 0)), ev('rubric_claimed', A, at(2, 12))] });

  it('reports the platform totals and the 48h target', () => {
    const summary = summarizeDelivery([delivered, stuck]);
    expect(summary).toMatchObject({ tasks: 2, submitted: 1, open: 1, submittedWithinTarget: 1, openOverTarget: 1, medianHoursToSubmit: 32, reviewReturns: 1, platformReturns: 0 });
    expect(summary.averageHoursByState.preparing).toBe(35);
    expect(summary.averageHoursByState.unassigned).toBe(7);
  });

  it('splits rubric creators from reviewers, with where their time went and what came back', () => {
    const summary = summarizeDelivery([delivered, stuck]);
    expect(summary.creators.get(A)).toEqual({
      tasks: 2,
      heldHours: 76,
      buildHours: 70,
      fixHours: 2,
      afterApprovalHours: 4,
      sent: 2,
      returnedByReview: 1,
      approved: 1,
      approvedFirstTime: 0,
      returnedByPlatform: 0,
      submitted: 1,
      openNow: 1,
      openOverTarget: 1,
    });
    expect(summary.reviewers.get(R)).toEqual({ tasks: 1, reviewHours: 12, decisions: 2, approved: 1, sentBack: 1, laterReturnedByPlatform: 0, openNow: 0 });
    expect(summary.creators.has(R)).toBe(false);
    expect(summary.reviewers.has(A)).toBe(false);
    expect(summary).toMatchObject({ approvals: 1, firstTimeApprovals: 0, reviewedTasks: 1, reviewRounds: 2 });
  });

  it('credits sends and decisions an admin made on someone else’s seat to the seat holder', () => {
    const onBehalf = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(2, 0)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('rubric_claimed', A, at(1, 1)),
        ev('sent_to_review', 'admin', at(1, 2)),
        ev('review_claimed', R, at(1, 3)),
        ev('review_changes_requested', 'admin', at(1, 4)),
      ],
    });
    const summary = summarizeDelivery([onBehalf]);
    expect(summary.creators.get(A)).toMatchObject({ sent: 1, returnedByReview: 1 });
    expect(summary.reviewers.get(R)).toMatchObject({ decisions: 1, sentBack: 1 });
    expect(summary.creators.has('admin') || summary.reviewers.has('admin')).toBe(false);
  });

  it('charges a platform return to the creator and to the reviewer who approved it', () => {
    const returned = replayTask({
      landedAt: at(1, 0),
      now: Date.parse(at(4, 6)),
      events: [
        ev('landed', null, at(1, 0)),
        ev('rubric_claimed', A, at(1, 0)),
        ev('sent_to_review', A, at(1, 4)),
        ev('review_claimed', R, at(1, 4)),
        ev('review_approved', R, at(1, 6)),
        ev('pushed_to_catalog', A, at(1, 10)),
        ev('catalog_returned', null, at(4, 0), { rubricAssigneeId: A }),
      ],
    });
    const summary = summarizeDelivery([returned]);
    expect(summary.creators.get(A)).toMatchObject({ approvedFirstTime: 1, returnedByPlatform: 1, openNow: 1, fixHours: 6 });
    expect(summary.reviewers.get(R)).toMatchObject({ approved: 1, laterReturnedByPlatform: 1 });
    expect(summary).toMatchObject({ approvals: 1, firstTimeApprovals: 1 });
  });
});

describe('exports', () => {
  const task = (id: string, landed: string, events: ReportEvent[]) => ({
    id,
    catalogSubmissionId: `${id}-0000-0000-0000-000000000000`,
    title: `Task ${id}`,
    landedAt: landed,
    workState: 'preparing' as const,
    timeline: replayTask({ landedAt: landed, events, now: Date.parse(at(5, 0)) }),
  });
  const names = new Map([[A, 'Ana'], [R, 'Rob'], ['other', 'Olga']]);
  const pingPong = task('aaaa1111', at(1, 0), [
    ev('landed', null, at(1, 0)),
    ev('rubric_claimed', A, at(1, 1)),
    ev('sent_to_review', A, at(1, 2)),
    ev('review_claimed', R, at(1, 3)),
    ev('review_changes_requested', R, at(1, 4)),
    ev('sent_to_review', A, at(2, 1)),
  ]);
  const someoneElse = task('bbbb2222', at(3, 0), [ev('landed', null, at(3, 0)), ev('rubric_claimed', 'other', at(3, 1))]);

  it('gives one person the full history of the tasks they touched, inside the window', () => {
    const rows = activityRows([pingPong, someoneElse], names, { startMs: Date.parse(at(1, 0)), endMs: Date.parse(at(2, 0)) }, A);
    expect(rows[0]).not.toContain('Title');
    expect(rows.slice(1).map((r) => [r[0], r[3], r[4], r[6]])).toEqual([
      ['aaaa1111', '', 'Waiting for a creator', ''],
      ['aaaa1111', 'Waiting for a creator', 'Preparing', 'Ana'],
      ['aaaa1111', 'Preparing', 'Waiting for a reviewer', 'Ana'],
      ['aaaa1111', 'Waiting for a reviewer', 'In review', 'Rob'],
      ['aaaa1111', 'In review', 'Review returned', 'Rob'],
    ]);
  });

  it('lists tasks that landed in the window with their state hours and people', () => {
    const rows = deliveryRows([pingPong, someoneElse], names, { startMs: Date.parse(at(1, 0)), endMs: Date.parse(at(2, 0)) });
    expect(rows).toHaveLength(2);
    const [header, row] = rows as [string[], (string | number | null)[]];
    expect(header).not.toContain('Title');
    expect(header).not.toContain('Full task id');
    const cell = (label: string) => row[header.indexOf(label)];
    expect(cell('Task')).toBe('aaaa1111');
    expect(cell('Current state')).toBe('In review');
    expect(cell('Hours in platform')).toBe(96);
    expect(cell('Within 48h')).toBe('no (open)');
    expect(cell('Hours: Review returned')).toBe(21);
    expect(cell('Review rounds')).toBe(2);
    expect(cell('Rubric creators')).toBe('Ana');
    expect(cell('Reviewers')).toBe('Rob');
    expect(cell('Path')).toBe('Waiting for a creator 1h → Preparing (Ana) 1h → Waiting for a reviewer 1h → In review (Rob) 1h → Review returned (Ana) 21h → In review (Rob) 71h, now');
  });

  it('shows a catch-up recovery as a step in the path', () => {
    const recovered = task('cccc3333', at(1, 0), [
      ev('landed', null, at(1, 0)),
      ev('pipeline_recovered', null, at(2, 0), { from: 'parked', to: { stage: 'done', reviewStatus: 'approved', handoffStatus: 'client_visible' } }),
    ]);
    const [header, row] = deliveryRows([recovered], names, { startMs: Date.parse(at(1, 0)), endMs: Date.parse(at(2, 0)) }) as [string[], (string | number | null)[]];
    expect(row[header.indexOf('Path')]).toBe('Restored by catch-up after 24h → Submitted');
  });
});