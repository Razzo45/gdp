import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiOutputFiles, goldenRatings, submissions } from '@/db/schema';
import { statementHash } from '@/domain/fingerprint';
import type { Db } from '@/db/types';
import type { Actor } from '@/lib/auth/permissions';
import { claimNext, complete, enqueue, expireOverdue, fail, heartbeat, JobConflict } from '@/lib/jobs/queue';
import { ServiceError } from '@/lib/services/errors';
import { decideReview, saveCalibration, sendToReview } from '@/lib/services/review';
import { currentRubric, goldenState, overrideGolden, saveStatements, statementsOf } from '@/lib/services/rubric';
import { assignSeat, claimSeat, claimsOverview, getVisibleSubmission, listSubmissions, releaseSeat } from '@/lib/services/submissions';
import { makeSubmission, makeUser, testDb } from './helpers/db';

let handle: Awaited<ReturnType<typeof testDb>>;
let db: Db;
let pm: Actor;
let creator: Actor;
let creator2: Actor;
let reviewer: Actor;

beforeAll(async () => {
  handle = await testDb();
  db = handle.db;
  pm = await makeUser(db, 'pm@example.com', ['pm']);
  creator = await makeUser(db, 'c1@example.com', ['rubric_creator']);
  creator2 = await makeUser(db, 'c2@example.com', ['rubric_creator']);
  reviewer = await makeUser(db, 'r1@example.com', ['reviewer']);
});
afterAll(async () => handle.close());

const expectStatus = async (p: Promise<unknown>, status: number) => {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ServiceError && e.status === status);
};

describe('migration', () => {
  it('applies 0001_init and is idempotent', async () => {
    const { migrate } = await import('@/db/migrate');
    expect(await migrate(db)).toEqual([]);
  });
});

describe('seats', () => {
  it('claims, blocks second claimant, releases, and tracks timestamps', async () => {
    const s = await makeSubmission(db);
    expect(s.lastClaimedAt).toBeNull();
    const claimed = await claimSeat(creator, s.id, 'rubric');
    expect(claimed.rubricAssigneeId).toBe(creator.id);
    expect(claimed.lastClaimedAt).not.toBeNull();
    await expectStatus(claimSeat(creator2, s.id, 'rubric'), 409);
    await expectStatus(releaseSeat(creator2, s.id, 'rubric'), 403);
    await expectStatus(claimSeat(reviewer, s.id, 'rubric'), 403);
    await expectStatus(claimSeat(reviewer, s.id, 'review'), 409); // not in review yet

    // Visibility: a second creator cannot see a task someone else holds; PM can.
    await expectStatus(getVisibleSubmission(db, creator2, s.id), 403);
    expect((await getVisibleSubmission(db, pm, s.id)).id).toBe(s.id);
    expect((await listSubmissions(creator2)).map((r) => r.id)).not.toContain(s.id);

    // Holders cannot release; only a PM can change assignment.
    await expectStatus(releaseSeat(creator, s.id, 'rubric'), 403);
    const released = await releaseSeat(pm, s.id, 'rubric');
    expect(released.rubricAssigneeId).toBeNull();
    await expectStatus(getVisibleSubmission(db, creator2, s.id), 403);
    const queue = await listSubmissions(creator2);
    const slot = queue.find((r) => r.id === s.id);
    expect(slot?.blinded).toBe(true);
    expect(slot?.title).toBe('');
  });

  it('lets PMs assign and lists claims', async () => {
    const s = await makeSubmission(db);
    await expectStatus(assignSeat(creator, s.id, 'rubric', creator2.id), 403);
    const assigned = await assignSeat(pm, s.id, 'rubric', creator2.id);
    expect(assigned.rubricAssigneeId).toBe(creator2.id);
    const overview = await claimsOverview(pm);
    const row = overview.find((r) => r.userId === creator2.id)!;
    expect(row.rubricSeats.map((x) => x.submissionId)).toContain(s.id);
    const mine = await listSubmissions(creator2, { mine: true });
    expect(mine.map((x) => x.id)).toContain(s.id);
    expect(mine.find((x) => x.id === s.id)!.rubricAssigneeName).toBe('c2');
  });
});

describe('rubric autosave with revision CAS', () => {
  it('saves, bumps revision, refuses stale writes with current state', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const first = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [
        { tag: 'Visual - Branding', statement: 'The title slide shows the client logo.', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
        { tag: 'Format/File', statement: 'Is the deck 16:9?', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
      ],
      deletes: [],
    });
    expect(first.revision).toBe(1);
    expect(first.statements).toHaveLength(2);
    expect(first.statements.map((x) => x.position)).toEqual([1, 2]);
    expect(first.warnings).toHaveLength(1); // the question

    // Stale write from another tab.
    let caught: ServiceError | null = null;
    try {
      await saveStatements(creator, s.id, { revision: 0, upserts: [], deletes: [first.statements[0]!.id] });
    } catch (e) {
      caught = e as ServiceError;
    }
    expect(caught?.status).toBe(409);
    expect((caught?.detail as { revision: number }).revision).toBe(1);
    expect((caught?.detail as { statements: unknown[] }).statements).toHaveLength(2);

    // Reorder + delete at the right revision.
    const second = await saveStatements(creator, s.id, { revision: 1, upserts: [], deletes: [first.statements[1]!.id], order: [first.statements[0]!.id] });
    expect(second.revision).toBe(2);
    expect(second.statements).toHaveLength(1);
    expect(second.statements[0]!.position).toBe(1);

    // Non-holder is refused.
    await expectStatus(saveStatements(creator2, s.id, { revision: 2, upserts: [], deletes: [] }), 403);
  });

  it('human override outranks AI and edits make AI ratings stale', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    const statement = saved.statements[0]!;
    const rubric = (await currentRubric(db, s.id))!;
    let state = await goldenState(db, rubric.id, [statement]);
    expect(state.gate.ok).toBe(false);
    expect(state.verdicts[statement.id]).toBeNull();

    await expectStatus(overrideGolden(creator, s.id, statement.id, true, 'ok'), 422);
    await db.insert(goldenRatings).values({
      rubricId: rubric.id,
      statementId: statement.id,
      source: 'ai',
      verdict: false,
      evidence: 'The title slide does not name the client.',
      basis: { statementHash: statementHash(statement), statementText: statement.statement },
    });
    state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    expect(state.sources[statement.id]).toBe('ai');
    expect(state.verdicts[statement.id]).toBe(false);

    await overrideGolden(creator, s.id, statement.id, true, 'Checked by hand on slide 1.');
    state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    expect(state.sources[statement.id]).toBe('human');
    expect(state.verdicts[statement.id]).toBe(true);
    expect(state.evidence[statement.id]).toBe('Checked by hand on slide 1.');
    expect(state.audit[statement.id]).toEqual({
      ai: { verdict: false, evidence: 'The title slide does not name the client.' },
      human: { verdict: true, evidence: 'Checked by hand on slide 1.' },
    });
    expect(state.ratings.filter((r) => r.statementId === statement.id)).toHaveLength(2);
    expect(state.gate.ok).toBe(true);
  });
});

describe('review flow', () => {
  async function readyForReview() {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: ['The deck names the client.', 'The deck has a title slide.', 'The chart axes are labelled.', 'Every slide has a footer.'].map((statement) => ({ tag: 'Content - Structural' as const, statement, notes: '', scope: 'output' as const, inputFileIds: [], outputFile: null })),
      deletes: [],
    });
    for (const st of saved.statements) await overrideGolden(creator, s.id, st.id, true, 'Verified manually.');
    return { s, statements: saved.statements };
  }

  it('requires AI output and golden 100% before review; gates approval to 20–50%', async () => {
    const { s, statements } = await readyForReview();
    await expectStatus(sendToReview(creator, s.id), 409); // no AI output
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc', storagePath: 'x', uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    const inReview = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(inReview.stage).toBe('review');
    expect(inReview.reviewStatus).toBe('pending');

    // The rubric is locked while in review.
    await expectStatus(saveStatements(creator, s.id, { revision: 1, upserts: [], deletes: [] }), 409);

    await claimSeat(reviewer, s.id, 'review');
    await expectStatus(saveCalibration(creator2, s.id, { answers: {}, evidence: {}, submit: false }), 403);
    const [a, b, c, d] = statements.map((x) => x.id) as [string, string, string, string];

    // Partial draft is fine; submit with gaps or thin evidence is not.
    await saveCalibration(reviewer, s.id, { answers: { [a]: true }, evidence: {}, submit: false });
    await expectStatus(saveCalibration(reviewer, s.id, { answers: { [a]: true }, evidence: {}, submit: true }), 422);
    await expectStatus(saveCalibration(reviewer, s.id, { answers: { [a]: true, [b]: true, [c]: true, [d]: false }, evidence: {}, submit: true }), 422);

    const noted = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));

    // 75% → out of band → approval refused, changes can be requested.
    await saveCalibration(reviewer, s.id, { answers: { [a]: true, [b]: true, [c]: true, [d]: false }, evidence: noted([a, b, c, d]), submit: true });
    await expectStatus(decideReview(reviewer, s.id, 'approved', ''), 409);
    await expectStatus(decideReview(reviewer, s.id, 'changes_requested', 'short'), 422);
    await decideReview(reviewer, s.id, 'changes_requested', 'Too lenient: tighten the structural checks.');
    let after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('rubric');
    expect(after.reviewStatus).toBe('changes_requested');

    // Back to review with a 25% score → approved → stability.
    await sendToReview(creator, s.id);
    await saveCalibration(reviewer, s.id, { answers: { [a]: true, [b]: false, [c]: false, [d]: false }, evidence: noted([a, b, c, d]), submit: true });
    await decideReview(reviewer, s.id, 'approved', '');
    after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('stability');
  });
});

describe('job queue', () => {
  it('is idempotent per request, one active per kind, leases with SKIP LOCKED', async () => {
    const s = await makeSubmission(db);
    const requestId = crypto.randomUUID();
    const job = await enqueue(db, { kind: 'golden_autorate', submissionId: s.id, rubricId: null, requestId, payload: {}, createdBy: creator.id });
    expect((await enqueue(db, { kind: 'golden_autorate', submissionId: s.id, rubricId: null, requestId, payload: {}, createdBy: creator.id })).id).toBe(job.id);
    await expect(enqueue(db, { kind: 'golden_autorate', submissionId: s.id, rubricId: null, requestId: crypto.randomUUID(), payload: {}, createdBy: creator.id })).rejects.toBeInstanceOf(JobConflict);

    const claimed = await claimNext(['golden_autorate']);
    expect(claimed?.job.id).toBe(job.id);
    expect(claimed?.job.status).toBe('running');
    expect(claimed?.job.attempts).toBe(1);
    expect(await claimNext(['golden_autorate'])).toBeNull(); // leased

    expect(await heartbeat(job.id, claimed!.leaseToken, { progress: { done: 1, total: 2 } })).toBe(true);
    expect(await heartbeat(job.id, crypto.randomUUID(), {})).toBe(false);

    // Lease expiry → reclaimable by another worker; old token no longer works.
    await db.execute(sql`update app.jobs set lease_until = now() - interval '1 minute' where id = ${job.id}`);
    const reclaimed = await claimNext(['golden_autorate']);
    expect(reclaimed?.job.id).toBe(job.id);
    expect(reclaimed?.job.attempts).toBe(2);
    expect(await complete(job.id, claimed!.leaseToken, {})).toBe(false);
    expect(await complete(job.id, reclaimed!.leaseToken, { ok: true })).toBe(true);

    // After success a new job can be enqueued; failures respect maxAttempts.
    const retry = await enqueue(db, { kind: 'golden_autorate', submissionId: s.id, rubricId: null, requestId: crypto.randomUUID(), payload: {}, createdBy: creator.id, maxAttempts: 1 });
    const c2 = await claimNext(['golden_autorate']);
    expect(c2?.job.id).toBe(retry.id);
    await fail(retry.id, c2!.leaseToken, 'boom', true);
    expect(await claimNext(['golden_autorate'])).toBeNull(); // attempts exhausted → failed
    expect(await expireOverdue()).toBe(0);
  });
});
