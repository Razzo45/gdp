import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiOutputFiles, calibrations, goldenRatings, jobs, rubrics, stabilityAcceptances, stabilityPasses, submissions } from '@/db/schema';
import { statementHash } from '@/domain/fingerprint';
import type { Db } from '@/db/types';
import type { Actor } from '@/lib/auth/permissions';
import { JOB_KINDS } from '@/db/schema';
import { claimNext, complete, enqueue, expireOverdue, fail, heartbeat, JobConflict } from '@/lib/jobs/queue';
import { ServiceError } from '@/lib/services/errors';
import { decideReview, saveCalibration, sendToReview } from '@/lib/services/review';
import { acceptStability } from '@/lib/services/stability';
import { KEEP, pruneGoldenRatings } from '@/lib/services/retention';
import { startGoldenAutorate, startHelper, startStabilityRun } from '@/lib/jobs/start';
import { compactBankRow, parseBank } from '@/domain/bank';
import { countFamilies, quotaSpread } from '@/domain/rubric';
import { addFromBank, currentRubric, goldenState, installFactoryVersion, overrideGolden, replaceRubricFromPaste, saveStatements, statementsOf } from '@/lib/services/rubric';
import { workStateOf } from '@/domain/workState';
import { assignSeat, claimSeat, claimsOverview, getVisibleSubmission, listSubmissions, recordEvent, releaseSeat } from '@/lib/services/submissions';
import { makeSubmission, makeUser, seatedRubricInputs, testDb, yesAnswers } from './helpers/db';

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
    expect(slot?.title).toBe('Deck');
    expect(slot?.catalogSubmissionId).toBe('');
    expect(slot?.projectId).toBe('');
    expect(slot?.projectName).toBe('Project');
    expect(slot?.rubricAssigneeName).toBeNull();
  });

  it('lists Hero deliverables from General Information on claim slots', async () => {
    const s = await makeSubmission(db, {
      source: {
        projectId: 'p1',
        projectSubmissionId: `cs-${crypto.randomUUID().slice(0, 8)}`,
        submission: {
          prompt: 'Make a deck.',
          generalInformation: { industry: 'Finance', heroDeliverables: 'Short-form video' },
        },
        files: [],
      },
    });
    const queue = await listSubmissions(creator2);
    expect(queue.find((r) => r.id === s.id)?.heroDeliverable).toBe('Short-form video');
  });

  it('shows reviewers the task id and rubric creator on review claim slots', async () => {
    const s = await makeSubmission(db, { stage: 'review', reviewStatus: 'pending', rubricAssigneeId: creator.id, catalogSubmissionId: '8bbe2180-aaaa-bbbb-cccc-000000000001' });
    const slot = (await listSubmissions(reviewer)).find((r) => r.id === s.id);
    expect(slot?.blinded).toBe(true);
    expect(slot?.catalogSubmissionId).toBe('8bbe2180-aaaa-bbbb-cccc-000000000001');
    expect(slot?.rubricAssigneeName).toBe('c1');
    expect(slot?.projectId).toBe('');
  });

  it('lists parked tasks for a PM so a catchup rewrite cannot empty the board', async () => {
    const s = await makeSubmission(db, { stage: 'parked', title: 'Parked deck' });
    const rows = await listSubmissions(pm);
    expect(rows.map((r) => r.id)).toContain(s.id);
    expect(rows.find((r) => r.id === s.id)?.workState).toBe('other');
  });

  it('lets PMs assign and lists claims', async () => {
    const s = await makeSubmission(db);
    await expectStatus(assignSeat(creator, s.id, 'rubric', creator2.id), 403);
    await expectStatus(assignSeat(pm, s.id, 'rubric', reviewer.id), 422);
    await expectStatus(assignSeat(pm, s.id, 'review', reviewer.id), 409);
    const pooled = await assignSeat(pm, s.id, 'rubric', null);
    expect(pooled.rubricAssigneeId).toBeNull();
    const assigned = await assignSeat(pm, s.id, 'rubric', creator2.id);
    expect(assigned.rubricAssigneeId).toBe(creator2.id);
    const overview = await claimsOverview(pm);
    const row = overview.find((r) => r.userId === creator2.id)!;
    expect(row.rubricSeats.map((x) => x.submissionId)).toContain(s.id);
    const mine = await listSubmissions(creator2, { mine: true });
    expect(mine.map((x) => x.id)).toContain(s.id);
    expect(mine.find((x) => x.id === s.id)!.rubricAssigneeName).toBe('c2');
  });

  it('lists last interaction from a person, not a Catalog refresh', async () => {
    const s = await makeSubmission(db);
    const claimed = await claimSeat(creator, s.id, 'rubric');
    await recordEvent(db, s.id, creator.id, 'upstream_changed', { statusId: 'sync' });
    await db.update(submissions).set({ lastSeenAt: '2026-12-01T00:00:00.000Z' }).where(eq(submissions.id, s.id));
    const row = (await listSubmissions(pm)).find((r) => r.id === s.id);
    expect(row?.lastInteractionAt).toBeTruthy();
    expect(row?.lastInteractionAt).not.toBe('2026-12-01T00:00:00.000Z');
    expect(Date.parse(row!.lastInteractionAt!)).toBeLessThanOrEqual(Date.parse(claimed.lastClaimedAt!) + 2_000);
  });

  it('assigns review only to the review team while the task is in review', async () => {
    const s = await makeSubmission(db, { stage: 'review', reviewStatus: 'pending', rubricAssigneeId: creator.id });
    await expectStatus(assignSeat(pm, s.id, 'rubric', creator2.id), 409);
    await expectStatus(assignSeat(pm, s.id, 'review', creator.id), 422);
    const assigned = await assignSeat(pm, s.id, 'review', reviewer.id);
    expect(assigned.reviewerId).toBe(reviewer.id);
    const pooled = await assignSeat(pm, s.id, 'review', null);
    expect(pooled.reviewerId).toBeNull();
  });

  it('locks dual-role users out of reviewing a task whose rubric seat they hold', async () => {
    const both = await makeUser(db, 'both@example.com', ['rubric_creator', 'reviewer']);
    const s = await makeSubmission(db, { stage: 'review', reviewStatus: 'pending', rubricAssigneeId: both.id });
    await expectStatus(claimSeat(both, s.id, 'review'), 403);
    await expectStatus(assignSeat(pm, s.id, 'review', both.id), 422);
    const other = await makeSubmission(db, { stage: 'review', reviewStatus: 'pending', rubricAssigneeId: creator.id });
    const claimed = await claimSeat(both, other.id, 'review');
    expect(claimed.reviewerId).toBe(both.id);
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
      ai: { verdict: false, evidence: 'The title slide does not name the client.', model: null },
      human: { verdict: true, evidence: 'Checked by hand on slide 1.' },
    });
    expect(state.ratings.filter((r) => r.statementId === statement.id)).toHaveLength(2);
    expect(state.gate.ok).toBe(true);
  });

  it('ignores imported human stubs so the Yes keeps its AI evidence', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    const statement = saved.statements[0]!;
    const rubric = (await currentRubric(db, s.id))!;
    await db.insert(goldenRatings).values([
      {
        rubricId: rubric.id,
        statementId: statement.id,
        source: 'ai',
        verdict: true,
        evidence: 'Slide 1 title reads Acme Corp.',
        model: 'gemini-3.8-flash',
        basis: { statementHash: statementHash(statement), statementText: statement.statement },
      },
      {
        rubricId: rubric.id,
        statementId: statement.id,
        source: 'human',
        verdict: true,
        evidence: 'Imported human override.',
        reason: 'Imported human override.',
        basis: { statementText: statement.statement, provenance: 'legacy-snapshot' },
      },
    ]);
    const state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    expect(state.sources[statement.id]).toBe('ai');
    expect(state.verdicts[statement.id]).toBe(true);
    expect(state.evidence[statement.id]).toBe('Slide 1 title reads Acme Corp.');
    expect(state.audit[statement.id]).toEqual({
      ai: { verdict: true, evidence: 'Slide 1 title reads Acme Corp.', model: 'gemini-3.8-flash' },
    });
  });

  it('keeps the last good Golden Yes when a later autorate only wrote Grading failed', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    const statement = saved.statements[0]!;
    const rubric = (await currentRubric(db, s.id))!;
    await db.insert(goldenRatings).values([
      {
        rubricId: rubric.id,
        statementId: statement.id,
        jobId: crypto.randomUUID(),
        source: 'ai',
        verdict: true,
        evidence: 'Slide 1 title reads Acme Corp.',
        basis: { statementHash: statementHash(statement) },
        createdAt: '2026-10-13T16:40:00.000Z',
      },
      {
        rubricId: rubric.id,
        statementId: statement.id,
        jobId: crypto.randomUUID(),
        source: 'ai',
        verdict: null,
        evidence: '',
        error: 'Grading failed.',
        basis: { statementHash: statementHash(statement) },
        createdAt: '2026-10-13T16:51:00.000Z',
      },
    ]);
    const state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    expect(state.verdicts[statement.id]).toBe(true);
    expect(state.evidence[statement.id]).toBe('Slide 1 title reads Acme Corp.');
    expect(state.sources[statement.id]).toBe('ai');
    expect(state.errors[statement.id]).toBeUndefined();
    expect(state.gate.ok).toBe(true);
  });
});

describe('rubric quota seats', () => {
  const passLint = {
    overall: 'pass' as const,
    verdicts: {
      falsifiable: 'pass',
      universal: 'pass',
      unambiguous: 'pass',
      self_contained: 'pass',
      non_stacked: 'pass',
      timeless: 'pass',
      expected_yes: 'pass',
      file_addressed_present: 'pass',
    } as const,
    reasons: [] as string[],
    rewriteSuggestion: '',
    source: 'local' as const,
  };

  it('refuses Add from the bank when that family is already 2 seats over quota', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    await installFactoryVersion(db, s.id, creator.id, {
      seeds: [],
      statements: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        family: 'format' as const,
        tag: 'Format/File',
        statement: `The delivered presentation uses a 16:9 page size on format seat ${i}.`,
        notes: '',
        claimKey: `fmt-${i}`,
        origin: 'factory' as const,
        lint: passLint,
        scope: 'output' as const,
        inputFileIds: [] as string[],
        outputFile: null,
      })),
      generation: {
        bank: [
          compactBankRow({
            claimKey: 'extra-fmt',
            statement: 'The delivered presentation uses a 4:3 page size.',
            tag: 'Format/File',
            family: 'format',
            notes: '',
            seedId: 's1',
          }),
          compactBankRow({
            claimKey: 'extra-content',
            statement: 'The deck names the extra content claim.',
            tag: 'Content - Exact',
            family: 'content',
            notes: '',
            seedId: 's1',
          }),
        ],
      },
    });
    await expectStatus(addFromBank(creator, s.id, { claimKey: 'extra-fmt', revision: 0 }), 409);
    const added = await addFromBank(creator, s.id, { claimKey: 'extra-content', revision: 0 });
    expect(added.statements).toHaveLength(8);
  });

  it('replaces the current rubric with a pasted 5 / 15 / 30 set and refuses a short paste', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const first = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    await expectStatus(replaceRubricFromPaste(creator, s.id, { revision: first.revision, rows: seatedRubricInputs().slice(0, 40) }), 422);
    const replaced = await replaceRubricFromPaste(creator, s.id, { revision: first.revision, rows: seatedRubricInputs() });
    expect(replaced.imported).toBe(50);
    expect(replaced.statements).toHaveLength(50);
    expect(replaced.statements.some((row) => row.statement === 'The deck names the client.')).toBe(false);
    const versions = await db.select().from(rubrics).where(eq(rubrics.submissionId, s.id));
    expect(versions.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(Math.max(...versions.map((row) => row.version))).toBe(2);
  });

  it('keeps a pasted Visual seat that also reads as Format, matching the modal 5 / 15 / 30 count', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const rows = seatedRubricInputs();
    rows[rows.length - 1] = {
      tag: 'Visual - Layout',
      statement: 'The five connected carousel images remain readable at 1080 x 1350 px.',
      notes: '',
      scope: 'output',
      inputFileIds: [],
      outputFile: null,
    };
    expect(quotaSpread(countFamilies(rows)).ready).toBe(true);
    const replaced = await replaceRubricFromPaste(creator, s.id, { revision: 0, rows });
    expect(replaced.imported).toBe(50);
    expect(countFamilies(replaced.statements)).toEqual({ format: 5, content: 15, visual: 30 });
    expect(replaced.statements.some((row) => row.statement.includes('carousel images') && row.family === 'visual')).toBe(true);
  });

  it('keeps the unused bank when a pasted rubric replaces the seats', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    await installFactoryVersion(db, s.id, creator.id, {
      seeds: ['seed-a'],
      statements: [0, 1, 2, 3, 4].map((i) => ({
        family: 'format' as const,
        tag: 'Format/File',
        statement: `The delivered presentation uses a 16:9 page size on format seat ${i}.`,
        notes: '',
        claimKey: `fmt-${i}`,
        origin: 'factory' as const,
        lint: passLint,
        scope: 'output' as const,
        inputFileIds: [] as string[],
        outputFile: null,
      })),
      generation: {
        bank: [
          compactBankRow({
            claimKey: 'spare-content',
            statement: 'The deck names the unused bank claim.',
            tag: 'Content - Exact',
            family: 'content',
            notes: '',
            seedId: 'seed-a',
          }),
        ],
      },
    });
    const first = await currentRubric(db, s.id);
    await replaceRubricFromPaste(creator, s.id, { revision: first!.revision, rows: seatedRubricInputs() });
    const next = await currentRubric(db, s.id);
    expect(parseBank(next?.generation).map((row) => row.claimKey)).toEqual(['spare-content']);
    expect(next?.seeds).toEqual(['seed-a']);
  });

  it('keeps a creator-seated Visual row on save when the edited wording looks like Format', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const first = await saveStatements(creator, s.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
    const visual = first.statements.find((row) => row.family === 'visual');
    expect(visual).toBeTruthy();
    const saved = await saveStatements(creator, s.id, {
      revision: first.revision,
      upserts: [
        {
          id: visual!.id,
          tag: 'Visual - Layout',
          statement:
            'Every text box, chart, shape, and image across all slides in the delivered presentation is positioned entirely within the 16:9 slide canvas boundaries without extending beyond the slide edges.',
          notes: visual!.notes,
          scope: visual!.scope,
          inputFileIds: visual!.inputFileIds,
          outputFile: visual!.outputFile,
        },
      ],
      deletes: [],
    });
    const row = saved.statements.find((item) => item.id === visual!.id);
    expect(row).toMatchObject({ family: 'visual', tag: 'Visual - Layout' });
    expect(countFamilies(saved.statements)).toEqual({ format: 5, content: 15, visual: 30 });
  });

  it('refuses Golden autorate until the 5 / 15 / 30 spread is seated', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    await expectStatus(startGoldenAutorate(creator, s.id, { requestId: crypto.randomUUID() }), 409);
  });
});

async function seedPreviewStability(submissionId: string, yes = 13) {
  const rubric = await currentRubric(db, submissionId);
  const ids = (await statementsOf(db, rubric!.id)).map((row) => row.id);
  const answers = yesAnswers(ids, yes);
  const groupId = crypto.randomUUID();
  await db.insert(stabilityPasses).values(
    [1, 2, 3].map((passIndex) => ({ rubricId: rubric!.id, groupId, passIndex, answers, evidence: {}, errors: {}, scorePercent: (yes / ids.length) * 100, basis: {} })),
  );
}

describe('review flow', () => {
  async function readyForReview() {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
    for (const st of saved.statements) await overrideGolden(creator, s.id, st.id, true, 'Verified manually.');
    await seedPreviewStability(s.id);
    return { s, statements: saved.statements };
  }

  it('refuses review without a current, in-band Stability run, and an edit stales Golden and Stability', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
    for (const st of saved.statements) await overrideGolden(creator, s.id, st.id, true, 'Verified manually.');
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-stale', storagePath: `stale-${s.id}`, uploadedBy: creator.id });
    await expect(sendToReview(creator, s.id)).rejects.toThrow('Run Stability before sending to review.');

    await seedPreviewStability(s.id, 38);
    await expect(sendToReview(creator, s.id)).rejects.toThrow('between 20% and 50%');

    await seedPreviewStability(s.id, 13);
    const fixture = seatedRubricInputs()[0]!;
    const target = saved.statements.find((row) => row.statement === fixture.statement)!;
    const seat = { ...fixture, id: target.id };
    const rubric = await currentRubric(db, s.id);
    const touched = await saveStatements(creator, s.id, { revision: rubric!.revision, upserts: [{ ...seat, notes: 'Only a note changed.' }], deletes: [] });
    expect((await goldenState(db, rubric!.id, touched.statements)).gate.ok).toBe(true);
    await sendToReview(creator, s.id);
    await db.update(submissions).set({ stage: 'rubric', reviewStatus: null }).where(eq(submissions.id, s.id));

    const reworded = await saveStatements(creator, s.id, { revision: touched.revision, upserts: [{ ...seat, statement: `${target.statement} Reworded.` }], deletes: [] });
    const golden = await goldenState(db, rubric!.id, reworded.statements);
    expect(golden.sources[target.id]).toBe('stale');
    expect(golden.gate.ok).toBe(false);
    await expectStatus(sendToReview(creator, s.id), 409);

    await overrideGolden(creator, s.id, target.id, true, 'Verified the new wording.');
    await expect(sendToReview(creator, s.id)).rejects.toThrow('Run Stability again: 1 seat changed since the last run.');
    await seedPreviewStability(s.id, 13);
    await sendToReview(creator, s.id);
  });

  it('clears a Catalog bounce when the creator sends the task to review', async () => {
    const { s } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-bounce', storagePath: `bounce-${s.id}`, uploadedBy: creator.id });
    await db.update(submissions).set({ handoffStatus: 'bounced' }).where(eq(submissions.id, s.id));
    await sendToReview(creator, s.id);
    const after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.handoffStatus).toBeNull();
    expect(workStateOf(after)).toBe('in_review');
  });

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
    const ids = statements.map((x) => x.id);
    const first = ids[0]!;

    // Partial draft is fine; submit with gaps or thin evidence is not.
    await saveCalibration(reviewer, s.id, { answers: { [first]: true }, evidence: {}, submit: false });
    await expectStatus(saveCalibration(reviewer, s.id, { answers: { [first]: true }, evidence: {}, submit: true }), 422);
    await expectStatus(saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 38), evidence: {}, submit: true }), 422);

    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));

    // 76% → out of band → approval refused, changes can be requested.
    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 38), evidence: noted, submit: true });
    await expectStatus(decideReview(reviewer, s.id, 'approved', ''), 409);
    await expectStatus(decideReview(reviewer, s.id, 'changes_requested', 'short'), 422);
    await decideReview(reviewer, s.id, 'changes_requested', 'Too lenient: tighten the structural checks.');
    let after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('rubric');
    expect(after.reviewStatus).toBe('changes_requested');
    expect(after.rubricAssigneeId).toBe(creator.id);
    await expectStatus(assignSeat(pm, s.id, 'review', reviewer.id), 409);

    // Back to review with a 26% score → approved → stability.
    await sendToReview(creator, s.id);
    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 13), evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'approved', '');
    after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('stability');
  });

  it('lets the reviewer rescore a returned eval and approve the new draft', async () => {
    const { s, statements } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-return', storagePath: `return-${s.id}`, uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    await claimSeat(reviewer, s.id, 'review');
    const ids = statements.map((x) => x.id);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));

    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 38), evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'changes_requested', 'Too lenient: tighten the structural checks.');
    await sendToReview(creator, s.id);

    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 13), evidence: noted, submit: false });
    await decideReview(reviewer, s.id, 'approved', '');
    const after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('stability');
    const rubric = await currentRubric(db, s.id);
    const latest = (await db.select().from(calibrations).where(eq(calibrations.rubricId, rubric!.id))).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1);
    expect(latest?.submitted).toBe(true);
    expect(latest?.scorePercent).toBe(26);
  });

  it('lets the reviewer send a returned eval back again with notes', async () => {
    const { s, statements } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-notes', storagePath: `notes-${s.id}`, uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    await claimSeat(reviewer, s.id, 'review');
    const ids = statements.map((x) => x.id);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));

    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 13), evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'changes_requested', 'Too lenient: tighten the structural checks.');
    await sendToReview(creator, s.id);
    await saveCalibration(reviewer, s.id, { answers: yesAnswers(ids, 25), evidence: noted, submit: false });
    await decideReview(reviewer, s.id, 'changes_requested', 'Still off: drop the extra structural yes.');
    const after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('rubric');
    expect(after.reviewStatus).toBe('changes_requested');
  });

  it('skips Stability and opens Ready to submit when the accepted run is still passing', async () => {
    const { s, statements } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-skip', storagePath: `skip-${s.id}`, uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    await claimSeat(reviewer, s.id, 'review');
    const ids = statements.map((x) => x.id);
    const answers = yesAnswers(ids, 13);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));
    await saveCalibration(reviewer, s.id, { answers, evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'approved', '');

    const rubric = await currentRubric(db, s.id);
    const groupId = crypto.randomUUID();
    await db.insert(stabilityPasses).values(
      [1, 2, 3].map((passIndex) => ({
        rubricId: rubric!.id,
        groupId,
        passIndex,
        answers,
        evidence: noted,
        errors: {},
        scorePercent: 26,
        basis: {},
      })),
    );
    await db.insert(stabilityAcceptances).values({ rubricId: rubric!.id, groupId, acceptedBy: creator.id, scores: [26, 26, 26], spread: 0, basis: {} });

    await db.update(submissions).set({ stage: 'review', reviewStatus: 'pending' }).where(eq(submissions.id, s.id));
    await decideReview(reviewer, s.id, 'approved', '');
    const after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('handoff');
    expect(after.handoffStatus).toBe('stability_pass');
    expect(workStateOf(after)).toBe('handoff');
  });

  it('starts Stability on a Platform returned task even when the last result was accepted', async () => {
    process.env['DATABASE_URL'] ??= 'postgres://test@localhost/test';
    process.env['GEMINI_API_KEY'] ??= 'test-key';
    process.env['AUTH_MODE'] ??= 'local';
    const { s, statements } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-unlock', storagePath: `unlock-${s.id}`, uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    await claimSeat(reviewer, s.id, 'review');
    const ids = statements.map((x) => x.id);
    const answers = yesAnswers(ids, 13);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));
    await saveCalibration(reviewer, s.id, { answers, evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'approved', '');

    const rubric = await currentRubric(db, s.id);
    const groupId = crypto.randomUUID();
    await db.insert(stabilityPasses).values(
      [1, 2, 3].map((passIndex) => ({
        rubricId: rubric!.id,
        groupId,
        passIndex,
        answers,
        evidence: noted,
        errors: {},
        scorePercent: 26,
        basis: {},
      })),
    );
    await db.insert(stabilityAcceptances).values({ rubricId: rubric!.id, groupId, acceptedBy: creator.id, scores: [26, 26, 26], spread: 0, basis: {} });

    await expect(startStabilityRun(creator, s.id, { requestId: crypto.randomUUID() })).rejects.toThrow(/accepted/i);

    await db.update(submissions).set({ stage: 'rubric', handoffStatus: 'bounced', pushedAt: null }).where(eq(submissions.id, s.id));
    await startStabilityRun(creator, s.id, { requestId: crypto.randomUUID() });
    expect(await db.select().from(stabilityAcceptances).where(eq(stabilityAcceptances.rubricId, rubric!.id))).toEqual([]);
  });

  it('marks a zip Stability run as archive, not heavy', async () => {
    process.env['GEMINI_API_KEY'] ??= 'test-key';
    const { s } = await readyForReview();
    await db.insert(aiOutputFiles).values({
      submissionId: s.id,
      name: 'maison-ai-output.zip',
      mime: 'application/zip',
      size: 100_899_604,
      sha256: 'zip-heavy',
      storagePath: `zip-${s.id}`,
      uploadedBy: creator.id,
    });
    const job = await startStabilityRun(creator, s.id, { requestId: crypto.randomUUID() });
    expect(job.payload['archive']).toBe(true);
    expect(job.payload['heavy']).toBeUndefined();
  });

  it('lets the creator continue to Ready to submit on an already-accepted Stability', async () => {
    const { s, statements } = await readyForReview();
    await db.insert(aiOutputFiles).values({ submissionId: s.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-cont', storagePath: `cont-${s.id}`, uploadedBy: creator.id });
    await sendToReview(creator, s.id);
    await claimSeat(reviewer, s.id, 'review');
    const ids = statements.map((x) => x.id);
    const answers = yesAnswers(ids, 13);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));
    await saveCalibration(reviewer, s.id, { answers, evidence: noted, submit: true });
    await decideReview(reviewer, s.id, 'approved', '');

    const rubric = await currentRubric(db, s.id);
    const groupId = crypto.randomUUID();
    await db.insert(stabilityPasses).values(
      [1, 2, 3].map((passIndex) => ({
        rubricId: rubric!.id,
        groupId,
        passIndex,
        answers,
        evidence: noted,
        errors: {},
        scorePercent: 26,
        basis: {},
      })),
    );
    await db.insert(stabilityAcceptances).values({ rubricId: rubric!.id, groupId, acceptedBy: creator.id, scores: [26, 26, 26], spread: 0, basis: {} });

    await acceptStability(creator, s.id, groupId);
    const after = (await db.select().from(submissions).where(eq(submissions.id, s.id)))[0]!;
    expect(after.stage).toBe('handoff');
    expect(after.handoffStatus).toBe('stability_pass');
  });
});

describe('retention', () => {
  it('keeps the current rubric and two previous versions', async () => {
    const s = await makeSubmission(db);
    const stub = (n: number) => [
      {
        family: 'content' as const,
        tag: 'Content - Exact',
        statement: `The title names the client ${n}.`,
        notes: '',
        claimKey: `title-${n}`,
        origin: 'factory' as const,
        lint: { overall: 'pass' as const, verdicts: { falsifiable: 'pass', universal: 'pass', unambiguous: 'pass', self_contained: 'pass', non_stacked: 'pass', timeless: 'pass', expected_yes: 'pass', file_addressed_present: 'pass' } as const, reasons: [], rewriteSuggestion: '', source: 'local' as const },
        scope: 'output' as const,
        inputFileIds: [] as string[],
        outputFile: null,
      },
    ];
    await installFactoryVersion(db, s.id, creator.id, { seeds: [], statements: stub(1), generation: {} });
    await installFactoryVersion(db, s.id, creator.id, { seeds: [], statements: stub(2), generation: {} });
    await installFactoryVersion(db, s.id, creator.id, { seeds: [], statements: stub(3), generation: {} });
    await installFactoryVersion(db, s.id, creator.id, { seeds: [], statements: stub(4), generation: {} });
    const versions = await db.select().from(rubrics).where(eq(rubrics.submissionId, s.id));
    expect(versions).toHaveLength(KEEP);
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(Math.max(...versions.map((v) => v.version))).toBe(4);
  });

  it('keeps Golden Yes and evidence on seats that were not in later one-seat reassesses', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [
        { tag: 'Content - Exact', statement: 'The deck names the client on seat one.', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
        { tag: 'Content - Exact', statement: 'The deck names the product on seat two.', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
        { tag: 'Content - Exact', statement: 'The deck names the market on seat three.', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
        { tag: 'Content - Exact', statement: 'The deck names the offer on seat four.', notes: '', scope: 'output', inputFileIds: [], outputFile: null },
      ],
      deletes: [],
    });
    const statements = saved.statements;
    const rubric = (await currentRubric(db, s.id))!;
    const fullJob = crypto.randomUUID();
    await db.insert(goldenRatings).values(
      statements.map((st) => ({
        rubricId: rubric.id,
        statementId: st.id,
        jobId: fullJob,
        source: 'ai' as const,
        verdict: true,
        evidence: `Observed yes on ${st.statement.slice(0, 24)}.`,
        basis: { statementHash: statementHash(st) },
        createdAt: '2026-10-13T10:00:00.000Z',
      })),
    );
    for (let i = 0; i < 3; i += 1) {
      const st = statements[i]!;
      await db.insert(goldenRatings).values({
        rubricId: rubric.id,
        statementId: st.id,
        jobId: crypto.randomUUID(),
        source: 'ai',
        verdict: true,
        evidence: `Reassessed yes on ${st.statement.slice(0, 24)}.`,
        basis: { statementHash: statementHash(st) },
        createdAt: `2026-10-13T11:0${i}:00.000Z`,
      });
    }

    await pruneGoldenRatings(db, rubric.id);
    const state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    const untouched = statements[3]!;
    expect(state.verdicts[untouched.id]).toBe(true);
    expect(state.evidence[untouched.id]).toBe('Observed yes on The deck names the offer.');
    expect(state.gate.ok).toBe(true);
    expect(state.gate.unanswered).toBe(0);
  });

  it('does not let failed autorate rows evict the last good Golden Yes', async () => {
    const s = await makeSubmission(db);
    await claimSeat(creator, s.id, 'rubric');
    const saved = await saveStatements(creator, s.id, {
      revision: 0,
      upserts: [{ tag: 'Content - Exact', statement: 'The deck names the client.', notes: '', scope: 'output', inputFileIds: [], outputFile: null }],
      deletes: [],
    });
    const statement = saved.statements[0]!;
    const rubric = (await currentRubric(db, s.id))!;
    await db.insert(goldenRatings).values({
      rubricId: rubric.id,
      statementId: statement.id,
      jobId: crypto.randomUUID(),
      source: 'ai',
      verdict: true,
      evidence: 'Slide 1 title reads Acme Corp.',
      basis: { statementHash: statementHash(statement) },
      createdAt: '2026-10-13T16:40:00.000Z',
    });
    for (let i = 0; i < 4; i += 1) {
      await db.insert(goldenRatings).values({
        rubricId: rubric.id,
        statementId: statement.id,
        jobId: crypto.randomUUID(),
        source: 'ai',
        verdict: null,
        evidence: '',
        error: 'Grading failed.',
        basis: { statementHash: statementHash(statement) },
        createdAt: `2026-10-13T16:5${i}:00.000Z`,
      });
    }
    await pruneGoldenRatings(db, rubric.id);
    const state = await goldenState(db, rubric.id, await statementsOf(db, rubric.id));
    expect(state.verdicts[statement.id]).toBe(true);
    expect(state.evidence[statement.id]).toBe('Slide 1 title reads Acme Corp.');
    expect(state.gate.ok).toBe(true);
  });

  it('overwrites a calibration draft instead of appending', async () => {
    const { s, statements } = await (async () => {
      const row = await makeSubmission(db);
      await claimSeat(creator, row.id, 'rubric');
      const saved = await saveStatements(creator, row.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
      for (const st of saved.statements) await overrideGolden(creator, row.id, st.id, true, 'Verified manually.');
      await seedPreviewStability(row.id);
      await db.insert(aiOutputFiles).values({ submissionId: row.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-draft', storagePath: `draft-${row.id}`, uploadedBy: creator.id });
      await sendToReview(creator, row.id);
      await claimSeat(reviewer, row.id, 'review');
      return { s: row, statements: saved.statements };
    })();
    const [a] = statements.map((x) => x.id);
    await saveCalibration(reviewer, s.id, { answers: { [a!]: true }, evidence: {}, submit: false });
    await saveCalibration(reviewer, s.id, { answers: { [a!]: false }, evidence: {}, submit: false });
    const rubric = await currentRubric(db, s.id);
    const mine = (await db.select().from(calibrations)).filter((r) => r.rubricId === rubric!.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.answers[a!]).toBe(false);
  });

  it('lets a seated reviewer start a new draft after a submitted evaluation', async () => {
    const { s, statements } = await (async () => {
      const row = await makeSubmission(db);
      await claimSeat(creator, row.id, 'rubric');
      const saved = await saveStatements(creator, row.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
      for (const st of saved.statements) await overrideGolden(creator, row.id, st.id, true, 'Verified manually.');
      await seedPreviewStability(row.id);
      await db.insert(aiOutputFiles).values({ submissionId: row.id, name: 'ai.pptx', mime: 'application/octet-stream', size: 3, sha256: 'abc-rescore', storagePath: `rescore-${row.id}`, uploadedBy: creator.id });
      await sendToReview(creator, row.id);
      await claimSeat(reviewer, row.id, 'review');
      return { s: row, statements: saved.statements };
    })();
    const ids = statements.map((row) => row.id);
    const noted = Object.fromEntries(ids.map((id) => [id, 'Checked on the output.']));
    const first = Object.fromEntries(ids.map((id, i) => [id, i === 0]));
    await saveCalibration(reviewer, s.id, { answers: first, evidence: noted, submit: true });
    await saveCalibration(reviewer, s.id, { answers: { [ids[0]!]: false }, evidence: {}, submit: false });
    const rubric = await currentRubric(db, s.id);
    const mine = (await db.select().from(calibrations)).filter((row) => row.rubricId === rubric!.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(mine).toHaveLength(2);
    expect(mine[0]?.submitted).toBe(true);
    expect(mine[1]?.submitted).toBe(false);
    expect(mine[1]?.answers[ids[0]!]).toBe(false);
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

  it('gives ten concurrent workers ten distinct jobs via SKIP LOCKED', async () => {
    const created = [];
    for (const row of await Promise.all(Array.from({ length: 10 }, () => makeSubmission(db)))) {
      created.push(
        await enqueue(db, {
          kind: 'golden_autorate',
          submissionId: row.id,
          rubricId: null,
          requestId: crypto.randomUUID(),
          payload: {},
          createdBy: creator.id,
        }),
      );
    }
    const claimed = await Promise.all(Array.from({ length: 10 }, () => claimNext(['golden_autorate'])));
    const ids = claimed.map((row) => row?.job.id);
    expect(ids.every((id): id is string => Boolean(id))).toBe(true);
    expect(new Set(ids).size).toBe(10);
    expect(new Set(ids)).toEqual(new Set(created.map((row) => row.id)));
    expect(await claimNext(['golden_autorate'])).toBeNull();
  });

  it('keeps a third heavy video job queued so light work can still claim', async () => {
    const rows = await Promise.all(Array.from({ length: 4 }, () => makeSubmission(db)));
    const light = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: rows[0]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const heavies = [];
    for (const row of rows.slice(1)) {
      heavies.push(
        await enqueue(db, {
          kind: 'golden_autorate',
          submissionId: row.id,
          rubricId: null,
          requestId: crypto.randomUUID(),
          payload: { heavy: true },
          createdBy: creator.id,
        }),
      );
    }
    const first = await claimNext(['golden_autorate']);
    const second = await claimNext(['golden_autorate']);
    const third = await claimNext(['golden_autorate']);
    const fourth = await claimNext(['golden_autorate']);
    expect([first?.job.id, second?.job.id, third?.job.id]).toEqual([light.id, heavies[0]!.id, heavies[1]!.id]);
    expect(fourth).toBeNull();
  });

  it('lets a site-zip archive run beside a video without taking a second archive slot', async () => {
    await db.update(jobs).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(inArray(jobs.status, ['queued', 'running']));
    const rows = await Promise.all(Array.from({ length: 5 }, () => makeSubmission(db)));
    const light = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: rows[0]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const archive1 = await enqueue(db, {
      kind: 'stability_run',
      submissionId: rows[1]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { archive: true },
      createdBy: creator.id,
    });
    const heavy = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: rows[2]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { heavy: true },
      createdBy: creator.id,
    });
    const archive2 = await enqueue(db, {
      kind: 'stability_run',
      submissionId: rows[3]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { archive: true },
      createdBy: creator.id,
    });
    const heavy2 = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: rows[4]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { heavy: true },
      createdBy: creator.id,
    });
    const claimed: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      const row = await claimNext(['golden_autorate', 'stability_run']);
      if (!row) break;
      claimed.push(row.job.id);
    }
    expect(claimed).toEqual(expect.arrayContaining([light.id, heavy.id, heavy2.id, archive1.id]));
    expect(claimed).not.toContain(archive2.id);
  });

  it('fails a crashed running job that has used every attempt so it stops blocking the task', async () => {
    const s = await makeSubmission(db);
    const job = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: s.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
      maxAttempts: 1,
    });
    const claimed = await claimNext(['golden_autorate']);
    expect(claimed?.job.id).toBe(job.id);
    await db.execute(sql`update app.jobs set lease_until = now() - interval '1 minute' where id = ${job.id}`);
    expect(await claimNext(['golden_autorate'])).toBeNull();
    expect(await expireOverdue()).toBe(1);
    const row = (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    expect(row?.status).toBe('failed');
    await expect(
      enqueue(db, { kind: 'golden_autorate', submissionId: s.id, rubricId: null, requestId: crypto.randomUUID(), payload: {}, createdBy: creator.id }),
    ).resolves.toMatchObject({ kind: 'golden_autorate' });
  });

  it('claims a helper job only after Golden, Stability, and rubric generation', async () => {
    const rows = await Promise.all(Array.from({ length: 4 }, () => makeSubmission(db)));
    const helper = await enqueue(db, {
      kind: 'rubric_helper',
      submissionId: rows[0]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const generate = await enqueue(db, {
      kind: 'rubric_generate',
      submissionId: rows[1]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const stability = await enqueue(db, {
      kind: 'stability_run',
      submissionId: rows[2]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const smallGolden = await enqueue(db, {
      kind: 'golden_autorate',
      submissionId: rows[3]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { statementIds: ['a'] },
      createdBy: creator.id,
    });
    const wanted = new Set([helper.id, generate.id, stability.id, smallGolden.id]);
    const claimed: string[] = [];
    for (let i = 0; i < 20 && claimed.length < wanted.size; i += 1) {
      const row = await claimNext(JOB_KINDS);
      if (!row) break;
      if (wanted.has(row.job.id)) claimed.push(row.job.id);
    }
    expect(claimed).toEqual([smallGolden.id, stability.id, generate.id, helper.id]);
  });

  it('claims a site-zip archive only after Golden, generate, and helper, so zip cannot starve the queue', async () => {
    await db.update(jobs).set({ status: 'cancelled', finishedAt: new Date().toISOString() }).where(inArray(jobs.status, ['queued', 'running']));
    const rows = await Promise.all(Array.from({ length: 3 }, () => makeSubmission(db)));
    const archive = await enqueue(db, {
      kind: 'stability_run',
      submissionId: rows[0]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: { archive: true },
      createdBy: creator.id,
    });
    const generate = await enqueue(db, {
      kind: 'rubric_generate',
      submissionId: rows[1]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const helper = await enqueue(db, {
      kind: 'rubric_helper',
      submissionId: rows[2]!.id,
      rubricId: null,
      requestId: crypto.randomUUID(),
      payload: {},
      createdBy: creator.id,
    });
    const claimed: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const row = await claimNext(JOB_KINDS);
      if (!row) break;
      claimed.push(row.job.id);
    }
    expect(claimed).toEqual([generate.id, helper.id, archive.id]);
  });

  it('runs one helper job at a time so it cannot fill the worker', async () => {
    await db.execute(sql`update app.jobs set status = 'cancelled' where status in ('queued', 'running')`);
    const rows = await Promise.all(Array.from({ length: 3 }, () => makeSubmission(db)));
    const helpers = [];
    for (const row of rows.slice(0, 2)) {
      helpers.push(await enqueue(db, { kind: 'rubric_helper', submissionId: row.id, rubricId: null, requestId: crypto.randomUUID(), payload: {}, createdBy: creator.id }));
    }
    const golden = await enqueue(db, { kind: 'golden_autorate', submissionId: rows[2]!.id, rubricId: null, requestId: crypto.randomUUID(), payload: {}, createdBy: creator.id });
    const first = await claimNext(JOB_KINDS);
    const second = await claimNext(JOB_KINDS);
    const third = await claimNext(JOB_KINDS);
    expect([first?.job.id, second?.job.id]).toEqual([golden.id, helpers[0]!.id]);
    expect(third).toBeNull();
    await complete(second!.job.id, second!.leaseToken, {});
    expect((await claimNext(JOB_KINDS))?.job.id).toBe(helpers[1]!.id);
  });
});

describe('rubric helper enqueue', () => {
  it('refuses a run without the rubric seat, Golden, Stability, or AI output', async () => {
    const s = await makeSubmission(db);
    await expectStatus(startHelper(creator, s.id, { requestId: crypto.randomUUID() }), 403);
    await claimSeat(creator, s.id, 'rubric');
    await expectStatus(startHelper(creator, s.id, { requestId: crypto.randomUUID() }), 409);
    await saveStatements(creator, s.id, { revision: 0, upserts: seatedRubricInputs(), deletes: [] });
    await expectStatus(startHelper(creator, s.id, { requestId: crypto.randomUUID() }), 409);
  });
});
