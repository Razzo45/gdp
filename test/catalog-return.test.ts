import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submissionEvents, watchedProjects } from '@/db/schema';
import { classifyCatalogListState } from '@/domain/catalogListState';
import { catalogReturnFromSync, parseCatalogReturn, shouldEnqueueCatalogReturn } from '@/domain/catalogReturn';
import { workStateOf } from '@/domain/workState';
import type { Actor } from '@/lib/auth/permissions';
import { ServiceError } from '@/lib/services/errors';
import { acceptCatalogReturn, dismissCatalogReturn, listPendingCatalogReturns } from '@/lib/services/catalogReturn';
import { listSubmissions, noteCatalogReturnIfNeeded } from '@/lib/services/submissions';
import { makeSubmission, makeUser, testDb } from './helpers/db';
import type { Db } from '@/db/types';

const WORK = 'work-status';
const HANDOFF = 'handoff-status';
const statuses = [{ statusId: WORK, name: 'In progress' }, { statusId: HANDOFF, name: 'Submitted' }];
const transitions = [
  { from: WORK, to: HANDOFF, trigger: 'submit' },
  { from: HANDOFF, to: WORK, trigger: 'revise' },
];

describe('shouldEnqueueCatalogReturn', () => {
  const returned = {
    stage: 'done',
    handoffStatus: 'client_visible' as const,
    catalogLane: 'platform_return' as const,
    catalogStatusId: WORK,
    existing: null,
  };

  it('enqueues when a submitted task is a Catalog platform return', () => {
    expect(shouldEnqueueCatalogReturn(returned)).toBe(true);
    expect(shouldEnqueueCatalogReturn({ ...returned, stage: 'handoff', handoffStatus: 'client_visible' })).toBe(true);
  });

  it('does not enqueue unless we already submitted and Catalog shows a return', () => {
    expect(shouldEnqueueCatalogReturn({ ...returned, stage: 'rubric', handoffStatus: null })).toBe(false);
    expect(shouldEnqueueCatalogReturn({ ...returned, catalogLane: 'submitted' })).toBe(false);
    expect(shouldEnqueueCatalogReturn({ ...returned, catalogStatusId: '' })).toBe(false);
  });

  it('does not enqueue the same Catalog status twice, whether pending or dismissed', () => {
    expect(shouldEnqueueCatalogReturn({ ...returned, existing: { statusId: WORK, statusName: null, trigger: 'revise', note: null, outcome: 'pending' } })).toBe(false);
    expect(shouldEnqueueCatalogReturn({ ...returned, existing: { statusId: WORK, statusName: null, trigger: 'revise', note: null, outcome: 'dismissed' } })).toBe(false);
  });

  it('enqueues again when Catalog returns to a different status', () => {
    expect(
      shouldEnqueueCatalogReturn({
        ...returned,
        catalogStatusId: 'other-return',
        existing: { statusId: WORK, statusName: null, trigger: 'revise', note: null, outcome: 'dismissed' },
      }),
    ).toBe(true);
  });
});

describe('catalogReturnFromSync', () => {
  it('classifies a revise-from-handoff as platform_return and keeps the note', () => {
    const result = catalogReturnFromSync({
      statusId: WORK,
      watched: { workStatusId: WORK, handoffStatusId: HANDOFF, project: { workflow: { statuses, transitions } } },
      source: {
        submission: {
          transitionLog: [
            { fromStatus: WORK, toStatus: HANDOFF, trigger: 'submit', timestamp: '2026-10-01T00:00:00.000Z' },
            { fromStatus: HANDOFF, toStatus: WORK, trigger: 'revise', timestamp: '2026-10-12T11:00:00.000Z', note: 'Tighten the fleet hours table.' },
          ],
        },
      },
    });
    expect(result.lane).toBe('platform_return');
    expect(result.detail).toEqual({
      statusId: WORK,
      statusName: 'In progress',
      trigger: 'revise',
      note: 'Tighten the fleet hours table.',
    });
    expect(classifyCatalogListState({
      statusId: WORK,
      workStatusId: WORK,
      handoffStatusId: HANDOFF,
      statuses,
      transitions,
      transitionLog: result.detail.trigger ? [{ fromStatus: HANDOFF, toStatus: WORK, trigger: 'revise', timestamp: '2026-10-12T11:00:00.000Z' }] : [],
    })).toBe('platform_return');
  });

  it('reads the why-note from the Catalog payload when the log only has the note schema', () => {
    const result = catalogReturnFromSync({
      statusId: WORK,
      watched: { workStatusId: WORK, handoffStatusId: HANDOFF, project: { workflow: { statuses, transitions } } },
      source: {
        submission: {
          note: 'The hours table still uses last quarter’s figures.',
          transitionLog: [
            { fromStatus: HANDOFF, toStatus: WORK, trigger: 'revise', timestamp: '2026-10-12T11:00:00.000Z', note: { isRequired: true, options: [] } },
          ],
        },
      },
    });
    expect(result.detail.note).toBe('The hours table still uses last quarter’s figures.');
  });

  it('reads a nested payload note.text and ignores the required-note flag', () => {
    const result = catalogReturnFromSync({
      statusId: WORK,
      watched: { workStatusId: WORK, handoffStatusId: HANDOFF, project: { workflow: { statuses, transitions } } },
      source: {
        submission: {
          workflowState: { note: { text: 'Send back — missing the source appendix.' } },
          transitionLog: [{ fromStatus: HANDOFF, toStatus: WORK, trigger: 'revise', timestamp: '2026-10-12T11:00:00.000Z' }],
        },
      },
    });
    expect(result.detail.note).toBe('Send back — missing the source appendix.');
  });
});

describe('parseCatalogReturn', () => {
  it('reads a stored pending row and rejects junk', () => {
    expect(parseCatalogReturn({ statusId: WORK, outcome: 'pending', trigger: 'revise', note: 'Fix it', statusName: 'In progress' })).toEqual({
      statusId: WORK,
      statusName: 'In progress',
      trigger: 'revise',
      note: 'Fix it',
      outcome: 'pending',
    });
    expect(parseCatalogReturn({})).toBeNull();
    expect(parseCatalogReturn(null)).toBeNull();
  });
});

describe('workStateOf after a Catalog or handoff bounce', () => {
  it('is Platform returned whenever handoff is bounced, including in rubric', () => {
    expect(workStateOf({ stage: 'rubric', rubricAssigneeId: 'x', reviewStatus: 'approved', handoffStatus: 'bounced' })).toBe('platform_returned');
    expect(workStateOf({ stage: 'handoff', rubricAssigneeId: 'x', reviewStatus: 'approved', handoffStatus: 'bounced' })).toBe('platform_returned');
  });
});

const WORKFLOW = {
  statuses: [
    { statusId: WORK, name: 'In progress' },
    { statusId: HANDOFF, name: 'Submitted' },
  ],
  transitions: [
    { from: WORK, to: HANDOFF, trigger: 'submit' },
    { from: HANDOFF, to: WORK, trigger: 'revise' },
  ],
};

const returnedSource = {
  submission: {
    transitionLog: [
      { fromStatus: WORK, toStatus: HANDOFF, trigger: 'submit', timestamp: '2026-10-01T00:00:00.000Z' },
      { fromStatus: HANDOFF, toStatus: WORK, trigger: 'revise', timestamp: '2026-10-12T11:00:00.000Z', note: 'Tighten the fleet hours table.' },
    ],
  },
  project: { workflow: WORKFLOW },
};

describe('Catalog return reconciliation', () => {
  let handle: Awaited<ReturnType<typeof testDb>>;
  let db: Db;
  let pm: Actor;
  let creator: Actor;
  let reviewer: Actor;

  beforeAll(async () => {
    handle = await testDb();
    db = handle.db;
    pm = await makeUser(db, 'pm-return@example.com', ['pm']);
    creator = await makeUser(db, 'rubric-return@example.com', ['rubric_creator']);
    reviewer = await makeUser(db, 'review-return@example.com', ['reviewer']);
    await db.insert(watchedProjects).values({
      projectId: 'p1',
      label: 'Return project',
      workStatusId: WORK,
      handoffStatusId: HANDOFF,
      project: { workflow: WORKFLOW },
    });
  });
  afterAll(async () => handle.close());

  const expectStatus = async (p: Promise<unknown>, status: number) => {
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.status === status);
  };

  async function submittedReturn() {
    return makeSubmission(db, {
      stage: 'done',
      handoffStatus: 'client_visible',
      statusId: WORK,
      source: returnedSource,
      pushedAt: '2026-10-11T12:00:00.000Z',
      pushReceipt: { catalogSubmissionId: 'kept' },
      rubricAssigneeId: creator.id,
      reviewerId: reviewer.id,
    });
  }

  it('enqueues a pending return without flipping stage or seats', async () => {
    const row = await submittedReturn();
    const noted = await noteCatalogReturnIfNeeded(db, row, null);
    expect(noted.stage).toBe('done');
    expect(noted.handoffStatus).toBe('client_visible');
    expect(noted.pushedAt).toBe(row.pushedAt);
    expect(noted.rubricAssigneeId).toBe(creator.id);
    expect(noted.reviewerId).toBe(reviewer.id);
    expect(noted.catalogReturn).toEqual({
      statusId: WORK,
      statusName: 'In progress',
      trigger: 'revise',
      note: 'Tighten the fleet hours table.',
      outcome: 'pending',
    });
    const again = await noteCatalogReturnIfNeeded(db, noted, null);
    expect(again.catalogReturn).toEqual(noted.catalogReturn);
    const pending = await listPendingCatalogReturns(pm);
    expect(pending.map((item) => item.id)).toContain(row.id);
    const events = await db.select().from(submissionEvents).where(eq(submissionEvents.submissionId, row.id));
    expect(events.filter((event) => event.action === 'catalog_return_pending')).toHaveLength(1);
  });

  it('does not enqueue while the task is still in the GDP pipeline', async () => {
    const row = await makeSubmission(db, { stage: 'rubric', statusId: WORK, source: returnedSource });
    const noted = await noteCatalogReturnIfNeeded(db, row, pm.id);
    expect(noted.catalogReturn).toBeNull();
    expect((await listPendingCatalogReturns(pm)).map((item) => item.id)).not.toContain(row.id);
  });

  it('accepts a return onto rubric / Platform returned, clears the push lock, and keeps seats', async () => {
    const row = await submittedReturn();
    await noteCatalogReturnIfNeeded(db, row, null);
    await expectStatus(acceptCatalogReturn(creator, row.id), 403);
    const accepted = await acceptCatalogReturn(pm, row.id);
    expect(accepted.stage).toBe('rubric');
    expect(accepted.handoffStatus).toBe('bounced');
    expect(accepted.pushedAt).toBeNull();
    expect(accepted.catalogReturn).toBeNull();
    expect(accepted.rubricAssigneeId).toBe(creator.id);
    expect(accepted.reviewerId).toBe(reviewer.id);
    expect(accepted.pushReceipt).toEqual({ catalogSubmissionId: 'kept' });
    expect(workStateOf(accepted)).toBe('platform_returned');
    const listed = await listSubmissions(pm, { workState: 'platform_returned' });
    expect(listed.map((item) => item.id)).toContain(row.id);
    expect(listed.find((item) => item.id === row.id)?.workState).toBe('platform_returned');
    expect((await listPendingCatalogReturns(pm)).map((item) => item.id)).not.toContain(row.id);
    await expectStatus(acceptCatalogReturn(pm, row.id), 409);
  });

  it('dismisses a return and leaves the task submitted', async () => {
    const row = await submittedReturn();
    await noteCatalogReturnIfNeeded(db, row, null);
    const dismissed = await dismissCatalogReturn(pm, row.id);
    expect(dismissed.stage).toBe('done');
    expect(dismissed.handoffStatus).toBe('client_visible');
    expect(dismissed.pushedAt).toBe(row.pushedAt);
    expect(dismissed.catalogReturn).toMatchObject({ statusId: WORK, outcome: 'dismissed' });
    expect((await listPendingCatalogReturns(pm)).map((item) => item.id)).not.toContain(row.id);
    const listed = await listSubmissions(pm, { workState: 'submitted' });
    expect(listed.map((item) => item.id)).toContain(row.id);
    await expectStatus(dismissCatalogReturn(pm, row.id), 409);
  });
});
