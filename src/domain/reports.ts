/**
 * PM reporting: replay a task's event log into the states it sat in, who
 * held each one, and how often it bounced. Queues (waiting for a person) are
 * split from work so a bottleneck shows up as "nobody picked it up" versus
 * "someone sat on it".
 */
import type { WorkState } from '@/domain/workState';

export const REPORT_STATES = ['unassigned', 'preparing', 'review_queue', 'in_review', 'review_returned', 'stability', 'handoff', 'platform_returned', 'submitted'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const REPORT_STATE_LABEL: Record<ReportState, string> = {
  unassigned: 'Waiting for a creator',
  preparing: 'Preparing',
  review_queue: 'Waiting for a reviewer',
  in_review: 'In review',
  review_returned: 'Review returned',
  stability: 'Approved',
  handoff: 'Ready to submit',
  platform_returned: 'Platform returned',
  submitted: 'Submitted',
};

/** A task should leave the platform within this many working-clock hours. */
export const DELIVERY_TARGET_HOURS = 48;

export interface ReportEvent {
  action: string;
  actorId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface Transition {
  at: string;
  from: ReportState | null;
  to: ReportState;
  action: string;
  actorId: string | null;
  /** Hours spent in `from`. */
  hoursInPrevious: number | null;
  rubricHolderId: string | null;
  reviewerId: string | null;
}

export interface Segment {
  state: ReportState;
  enteredAt: string;
  leftAt: string | null;
  hours: number;
  /** Who the state was waiting on when it ended (or now). */
  holderId: string | null;
  /** False before a catch-up recovery: that time was spent outside this platform. */
  timed: boolean;
}

export interface TaskTimeline {
  transitions: Transition[];
  segments: Segment[];
  hoursByState: Record<ReportState, number>;
  /** Hours outside Submitted. A Catalog return restarts the clock. */
  totalHours: number;
  submittedAt: string | null;
  reviewRounds: number;
  reviewReturns: number;
  platformReturns: number;
  /** A catch-up script restored this task's state; time before that happened elsewhere. */
  recovered: boolean;
}

/** State a catch-up restored (`pipeline_recovered` detail.to), or null to leave the state alone. */
function recoveredState(to: unknown, reviewer: string | null, rubric: string | null): ReportState | null {
  if (!to || typeof to !== 'object') return null;
  const { stage, reviewStatus, handoffStatus } = to as { stage?: string; reviewStatus?: string | null; handoffStatus?: string | null };
  if (stage === 'done') return 'submitted';
  if (handoffStatus === 'bounced') return 'platform_returned';
  if (stage === 'handoff') return 'handoff';
  if (stage === 'stability') return 'stability';
  if (stage === 'review') return reviewer ? 'in_review' : 'review_queue';
  if (stage === 'rubric') return reviewStatus === 'changes_requested' ? 'review_returned' : rubric ? 'preparing' : 'unassigned';
  return null;
}

/**
 * Not stored: the report adds it when the board says Submitted but the log
 * never got there (a Catalog sync moved the task without a state event).
 */
export const CATALOG_MARKED_DONE = 'catalog_marked_done';

const HANDOFF_ACTIONS = new Set(['stability_accepted', 'handoff_ready_for_review', 'handoff_stability_pass', 'handoff_final_review_pass']);

/** Every event that can move a task or change who holds it. */
export const REPORT_ACTIONS = [
  'landed',
  'rubric_claimed',
  'rubric_assigned',
  'rubric_released',
  'review_claimed',
  'review_assigned',
  'review_released',
  'sent_to_review',
  'review_changes_requested',
  'stability_reopened_rubric',
  'review_approved',
  'handoff_bounced',
  'catalog_returned',
  'pushed_to_catalog',
  'pipeline_recovered',
  ...HANDOFF_ACTIONS,
];

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Report window from `?from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC days, `to` inclusive). Defaults to the last 30 days. */
export function reportRange(params: { from?: string | null; to?: string | null }, now = Date.now()): { from: string; to: string; startMs: number; endMs: number } {
  const today = new Date(now).toISOString().slice(0, 10);
  const to = params.to && DAY.test(params.to) && Number.isFinite(Date.parse(params.to)) ? params.to : today;
  const fallbackFrom = new Date(Date.parse(to) - 29 * DAY_MS).toISOString().slice(0, 10);
  const from = params.from && DAY.test(params.from) && Number.isFinite(Date.parse(params.from)) && params.from <= to ? params.from : fallbackFrom;
  return { from, to, startMs: Date.parse(from), endMs: Date.parse(to) + DAY_MS };
}

/** Spreadsheet-friendly UTC stamp. */
export function reportStamp(stamp: string | null | undefined): string {
  const ms = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(ms)) return '';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
export const reportHours = (hours: number | null | undefined) => (hours === null || hours === undefined ? null : Math.round(hours * 10) / 10);

const hoursBetween = (from: string, to: number) => Math.max(0, (to - Date.parse(from)) / 3_600_000);
const userIdOf = (detail: Record<string, unknown>) => (typeof detail['userId'] === 'string' ? detail['userId'] : null);

function holderOf(state: ReportState, rubricHolderId: string | null, reviewerId: string | null): string | null {
  if (state === 'unassigned' || state === 'review_queue' || state === 'submitted') return null;
  if (state === 'in_review') return reviewerId;
  return rubricHolderId;
}

export function replayTask(input: { landedAt: string; events: readonly ReportEvent[]; now: number }): TaskTimeline {
  const events = input.events.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let state: ReportState = 'unassigned';
  let enteredAt = events[0]?.action === 'landed' ? events[0].createdAt : input.landedAt;
  let rubric: string | null = null;
  let reviewer: string | null = null;
  let reviewRounds = 0;
  let reviewReturns = 0;
  let platformReturns = 0;
  let recovered = false;
  let submittedAt: string | null = null;
  const segments: Segment[] = [];
  const transitions: Transition[] = [{ at: enteredAt, from: null, to: 'unassigned', action: 'landed', actorId: events[0]?.action === 'landed' ? events[0].actorId : null, hoursInPrevious: null, rubricHolderId: null, reviewerId: null }];

  for (const event of events) {
    let next: ReportState = state;
    switch (event.action) {
      case 'rubric_claimed':
        rubric = event.actorId;
        if (state === 'unassigned') next = 'preparing';
        break;
      case 'rubric_assigned':
        rubric = userIdOf(event.detail);
        if (rubric && state === 'unassigned') next = 'preparing';
        if (!rubric && state === 'preparing') next = 'unassigned';
        break;
      case 'rubric_released':
        rubric = null;
        if (state === 'preparing') next = 'unassigned';
        break;
      case 'review_claimed':
        reviewer = event.actorId;
        if (state === 'review_queue') next = 'in_review';
        break;
      case 'review_assigned':
        reviewer = userIdOf(event.detail);
        if (reviewer && state === 'review_queue') next = 'in_review';
        if (!reviewer && state === 'in_review') next = 'review_queue';
        break;
      case 'review_released':
        reviewer = null;
        if (state === 'in_review') next = 'review_queue';
        break;
      case 'sent_to_review':
        rubric ??= event.actorId;
        reviewRounds += 1;
        next = reviewer ? 'in_review' : 'review_queue';
        break;
      case 'review_changes_requested':
        reviewer ??= event.actorId;
        reviewReturns += 1;
        next = 'review_returned';
        break;
      case 'stability_reopened_rubric':
        reviewReturns += 1;
        next = 'review_returned';
        break;
      case 'review_approved':
        reviewer ??= event.actorId;
        next = event.detail['stage'] === 'handoff' ? 'handoff' : 'stability';
        break;
      case 'handoff_bounced':
      case 'catalog_returned':
        if (event.action === 'catalog_returned' && typeof event.detail['rubricAssigneeId'] === 'string') rubric = event.detail['rubricAssigneeId'];
        platformReturns += 1;
        next = 'platform_returned';
        break;
      case 'pushed_to_catalog':
      case CATALOG_MARKED_DONE:
        next = 'submitted';
        break;
      case 'pipeline_recovered':
        recovered = true;
        for (const segment of segments) segment.timed = false;
        segments.push({ state, enteredAt, leftAt: event.createdAt, hours: hoursBetween(enteredAt, Date.parse(event.createdAt)), holderId: holderOf(state, rubric, reviewer), timed: false });
        enteredAt = event.createdAt;
        next = recoveredState(event.detail['to'], reviewer, rubric) ?? state;
        if (next !== state) transitions.push({ at: event.createdAt, from: state, to: next, action: event.action, actorId: event.actorId, hoursInPrevious: null, rubricHolderId: rubric, reviewerId: reviewer });
        state = next;
        submittedAt = next === 'submitted' ? event.createdAt : null;
        continue;
      default:
        if (HANDOFF_ACTIONS.has(event.action)) next = 'handoff';
    }
    if (next === state) continue;
    const left = Date.parse(event.createdAt);
    const hours = hoursBetween(enteredAt, left);
    segments.push({ state, enteredAt, leftAt: event.createdAt, hours, holderId: holderOf(state, rubric, reviewer), timed: true });
    transitions.push({ at: event.createdAt, from: state, to: next, action: event.action, actorId: event.actorId, hoursInPrevious: hours, rubricHolderId: rubric, reviewerId: reviewer });
    state = next;
    enteredAt = event.createdAt;
    submittedAt = next === 'submitted' ? event.createdAt : null;
  }
  segments.push({ state, enteredAt, leftAt: null, hours: hoursBetween(enteredAt, input.now), holderId: holderOf(state, rubric, reviewer), timed: true });

  const timed = segments.filter((s) => s.timed);
  const hoursByState = Object.fromEntries(REPORT_STATES.map((s) => [s, 0])) as Record<ReportState, number>;
  for (const segment of timed) hoursByState[segment.state] += segment.hours;
  const totalHours = timed.filter((s) => s.state !== 'submitted').reduce((sum, s) => sum + s.hours, 0);
  return { transitions, segments, hoursByState, totalHours, submittedAt, reviewRounds, reviewReturns, platformReturns, recovered };
}

export interface PersonDelivery {
  tasks: number;
  /** Hours tasks sat waiting on this person, by state. */
  hoursByState: Record<ReportState, number>;
  heldHours: number;
  sent: number;
  /** Sends after the first on the same task: each one is a review round trip. */
  resent: number;
  returnsReceived: number;
  approved: number;
  returnsGiven: number;
  submitted: number;
}

export interface DeliverySummary {
  tasks: number;
  /** Restored by a catch-up script. Work after the recovery counts; time-to-submit figures leave them out. */
  recovered: number;
  submitted: number;
  open: number;
  submittedWithinTarget: number;
  openOverTarget: number;
  medianHoursToSubmit: number | null;
  p90HoursToSubmit: number | null;
  reviewReturns: number;
  platformReturns: number;
  averageHoursByState: Record<ReportState, number>;
  people: Map<string, PersonDelivery>;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

const emptyHours = () => Object.fromEntries(REPORT_STATES.map((s) => [s, 0])) as Record<ReportState, number>;

export function summarizeDelivery(timelines: readonly TaskTimeline[]): DeliverySummary {
  const people = new Map<string, PersonDelivery & { taskSet: Set<number> }>();
  const person = (id: string, task: number) => {
    let row = people.get(id);
    if (!row) {
      row = { tasks: 0, hoursByState: emptyHours(), heldHours: 0, sent: 0, resent: 0, returnsReceived: 0, approved: 0, returnsGiven: 0, submitted: 0, taskSet: new Set() };
      people.set(id, row);
    }
    row.taskSet.add(task);
    return row;
  };
  const averageHoursByState = emptyHours();
  const toSubmit: number[] = [];
  let submittedWithinTarget = 0;
  let open = 0;
  let openOverTarget = 0;
  let reviewReturns = 0;
  let platformReturns = 0;

  timelines.forEach((timeline, task) => {
    for (const state of REPORT_STATES) averageHoursByState[state] += timeline.hoursByState[state] / timelines.length;
    reviewReturns += timeline.reviewReturns;
    platformReturns += timeline.platformReturns;
    if (timeline.submittedAt) {
      if (!timeline.recovered) {
        toSubmit.push(timeline.totalHours);
        if (timeline.totalHours <= DELIVERY_TARGET_HOURS) submittedWithinTarget += 1;
      }
    } else {
      open += 1;
      if (timeline.totalHours > DELIVERY_TARGET_HOURS) openOverTarget += 1;
    }
    for (const segment of timeline.segments) {
      if (!segment.holderId || !segment.timed) continue;
      const row = person(segment.holderId, task);
      row.hoursByState[segment.state] += segment.hours;
      row.heldHours += segment.hours;
    }
    let sends = 0;
    for (const t of timeline.transitions) {
      if (t.action === 'sent_to_review' && t.actorId) {
        const row = person(t.actorId, task);
        row.sent += 1;
        if (sends > 0) row.resent += 1;
        sends += 1;
      }
      if (t.action === 'review_approved' && t.actorId) person(t.actorId, task).approved += 1;
      if (t.action === 'review_changes_requested' && t.actorId) person(t.actorId, task).returnsGiven += 1;
      if ((t.action === 'review_changes_requested' || t.action === 'stability_reopened_rubric') && t.rubricHolderId) person(t.rubricHolderId, task).returnsReceived += 1;
      if (t.action === 'pushed_to_catalog' && t.rubricHolderId) person(t.rubricHolderId, task).submitted += 1;
    }
  });

  const sorted = toSubmit.toSorted((a, b) => a - b);
  return {
    tasks: timelines.length,
    recovered: timelines.filter((timeline) => timeline.recovered).length,
    submitted: toSubmit.length,
    open,
    submittedWithinTarget,
    openOverTarget,
    medianHoursToSubmit: percentile(sorted, 0.5),
    p90HoursToSubmit: percentile(sorted, 0.9),
    reviewReturns,
    platformReturns,
    averageHoursByState,
    people: new Map([...people].map(([id, { taskSet, ...row }]) => [id, { ...row, tasks: taskSet.size }])),
  };
}

export interface ReportTask {
  id: string;
  catalogSubmissionId: string;
  title: string;
  landedAt: string;
  workState: WorkState;
  timeline: TaskTimeline;
}

const RUBRIC_STATES = new Set<ReportState>(['preparing', 'review_returned', 'stability', 'handoff', 'platform_returned']);
const CLOCK_STATES = REPORT_STATES.filter((s) => s !== 'submitted');

function peopleOn(timeline: TaskTimeline, rubricSide: boolean): string[] {
  const ids = new Set<string>();
  for (const segment of timeline.segments) {
    if (!segment.holderId) continue;
    if (rubricSide ? RUBRIC_STATES.has(segment.state) : segment.state === 'in_review') ids.add(segment.holderId);
  }
  return [...ids];
}

function involves(timeline: TaskTimeline, userId: string): boolean {
  return (
    timeline.segments.some((s) => s.holderId === userId) ||
    timeline.transitions.some((t) => t.actorId === userId || t.rubricHolderId === userId || t.reviewerId === userId)
  );
}

/** Every state in order, with holder and hours, e.g. `Preparing (Ana) 10h → In review (Rob) 6h, now`. */
export function taskPath(timeline: TaskTimeline, name: (id: string) => string): string {
  const before = timeline.segments.filter((s) => !s.timed).reduce((sum, s) => sum + s.hours, 0);
  const steps = timeline.recovered ? [`Restored by catch-up after ${reportHours(before)}h`] : [];
  for (const segment of timeline.segments) {
    if (!segment.timed) continue;
    const open = segment.leftAt === null;
    const who = segment.holderId ? ` (${name(segment.holderId)})` : '';
    steps.push(open && segment.state === 'submitted' ? REPORT_STATE_LABEL.submitted : `${REPORT_STATE_LABEL[segment.state]}${who} ${reportHours(segment.hours)}h${open ? ', now' : ''}`);
  }
  return steps.join(' → ');
}

/** One row per task that landed in the window: where its time went and who held it. */
export function deliveryRows(tasks: readonly ReportTask[], names: ReadonlyMap<string, string>, range: { startMs: number; endMs: number }): (string | number | null)[][] {
  const name = (id: string) => names.get(id) ?? id;
  const rows: (string | number | null)[][] = [
    [
      'Task',
      'Landed (UTC)',
      'Submitted (UTC)',
      'Current state',
      'Hours in platform',
      `Within ${DELIVERY_TARGET_HOURS}h`,
      ...CLOCK_STATES.map((s) => `Hours: ${REPORT_STATE_LABEL[s]}`),
      'Review rounds',
      'Review returns',
      'Platform returns',
      'Rubric creators',
      'Reviewers',
      'Path',
    ],
  ];
  for (const task of tasks) {
    const landed = Date.parse(task.landedAt);
    if (!(landed >= range.startMs && landed < range.endMs)) continue;
    const t = task.timeline;
    rows.push([
      task.catalogSubmissionId.slice(0, 8),
      reportStamp(task.landedAt),
      reportStamp(t.submittedAt),
      REPORT_STATE_LABEL[t.transitions.at(-1)?.to ?? 'unassigned'],
      reportHours(t.totalHours),
      t.submittedAt ? (t.recovered ? 'n/a (catch-up)' : t.totalHours <= DELIVERY_TARGET_HOURS ? 'yes' : 'no') : t.totalHours > DELIVERY_TARGET_HOURS ? 'no (open)' : 'open',
      ...CLOCK_STATES.map((s) => reportHours(t.hoursByState[s])),
      t.reviewRounds,
      t.reviewReturns,
      t.platformReturns,
      peopleOn(t, true).map(name).join('; '),
      peopleOn(t, false).map(name).join('; '),
      taskPath(t, name),
    ]);
  }
  return rows;
}

/** Every state change in the window. With a person: the full history of each task they held or moved. */
export function activityRows(
  tasks: readonly ReportTask[],
  names: ReadonlyMap<string, string>,
  range: { startMs: number; endMs: number },
  userId?: string | null,
): (string | number | null)[][] {
  const name = (id: string | null) => (id ? (names.get(id) ?? id) : '');
  const rows: (string | number | null)[][] = [['Task', 'Task landed (UTC)', 'Changed (UTC)', 'From', 'To', 'Hours in previous state', 'Changed by', 'Rubric holder', 'Reviewer', 'Event']];
  const found: { at: number; row: (string | number | null)[] }[] = [];
  for (const task of tasks) {
    if (userId && !involves(task.timeline, userId)) continue;
    for (const t of task.timeline.transitions) {
      const at = Date.parse(t.at);
      if (!(at >= range.startMs && at < range.endMs)) continue;
      found.push({
        at,
        row: [
          task.catalogSubmissionId.slice(0, 8),
          reportStamp(task.landedAt),
          reportStamp(t.at),
          t.from ? REPORT_STATE_LABEL[t.from] : '',
          REPORT_STATE_LABEL[t.to],
          reportHours(t.hoursInPrevious),
          name(t.actorId),
          name(t.rubricHolderId),
          name(t.reviewerId),
          t.action,
        ],
      });
    }
  }
  for (const item of found.toSorted((a, b) => a.at - b.at)) rows.push(item.row);
  return rows;
}