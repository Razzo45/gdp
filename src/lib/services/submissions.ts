import 'server-only';

import { and, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { profiles, submissionEvents, submissions, userRoles, watchedProjects, type Submission } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { sourceFingerprint } from '@/domain/fingerprint';
import { canAssignSeatAt, isEligibleAssignee, seatTeamLabel, type AssignmentSeat } from '@/domain/assignment';
import { capsFor } from '@/lib/auth/workMode';
import { canCreateRubrics, canOversee, canReview, canSeeSubmission, claimableSeat, isController, isOwnRubricSeat, type Actor } from '@/lib/auth/permissions';
import { catalogReturnFromSync, landFromParked, lastRubricHolder, parseCatalogReturn, shouldEnqueueCatalogReturn } from '@/domain/catalogReturn';
import { pipelineFromListState } from '@/domain/catalogListState';
import { isUserInteraction } from '@/domain/dashboard';
import { workStateOf, type WorkState } from '@/domain/workState';
import { fetchSubmission } from '@/lib/catalog/client';
import { heroDeliverableFromSource, projectDisplayName, readCatalogSubmission, readProjectStatuses } from '@/lib/catalog/read';
import type { CatalogSubmission } from '@/lib/catalog/types';
import { scheduleWorkStatusSheet } from '@/lib/sheets/workStatus';
import { conflict, forbidden, invalid, notFound, ServiceError } from './errors';

/**
 * Submissions = Catalog tasks this platform is working on.
 *
 * `landed_at` is the first time we saw the task; `last_seen_at` the latest
 * sync; `last_claimed_at` the latest time any seat changed hands. Those are
 * the timestamps PMs asked for.
 */

export async function recordEvent(database: DbOrTx, submissionId: string, actorId: string | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await database.insert(submissionEvents).values({ submissionId, actorId, action, detail });
}

export function readSource(submission: Pick<Submission, 'source'>): CatalogSubmission | null {
  const source = submission.source as { submission?: unknown; project?: unknown };
  return readCatalogSubmission(source.submission, source.project ?? null);
}

/** Pulls the latest Catalog state and upserts our record. Safe to call often. */
export async function syncSubmission(catalogSubmissionId: string, actorId: string | null, hint?: { returnNote?: string | null }): Promise<Submission> {
  const fetched = await fetchSubmission(catalogSubmissionId);
  if (!fetched.ok) throw new ServiceError(fetched.status === 404 ? 404 : 502, fetched.error);
  const read = readCatalogSubmission(fetched.submission, fetched.project);
  if (!read) throw new ServiceError(502, 'The Catalog payload could not be read.');

  const source = { submission: fetched.submission, project: fetched.project };
  const fp = sourceFingerprint(fetched.submission);
  const now = new Date().toISOString();

  const result = await db().transaction(async (tx) => {
    const existing = (await tx.select().from(submissions).where(eq(submissions.catalogSubmissionId, catalogSubmissionId)).limit(1))[0];
    if (!existing) {
      const [created] = await tx
        .insert(submissions)
        .values({
          catalogSubmissionId,
          projectId: read.projectId,
          statusId: read.statusId,
          title: read.title,
          source,
          sourceFingerprint: fp,
          landedAt: now,
          lastSeenAt: now,
          stage: 'parked',
        })
        .returning();
      await recordEvent(tx, created!.id, actorId, 'landed', { statusId: read.statusId, projectId: read.projectId });
      return { previous: null, next: await noteCatalogReturnIfNeeded(tx, await landParkedIfInbound(tx, created!), actorId, hint?.returnNote) };
    }
    const changed = existing.sourceFingerprint !== fp;
    const statusMoved = existing.statusId !== read.statusId;
    const [updated] = await tx
      .update(submissions)
      .set({
        statusId: read.statusId,
        title: read.title || existing.title,
        source,
        sourceFingerprint: fp,
        lastSeenAt: now,
        ...(changed || statusMoved ? { upstreamChangedAt: now } : {}),
      })
      .where(eq(submissions.id, existing.id))
      .returning();
    if (changed || statusMoved) await recordEvent(tx, existing.id, actorId, 'upstream_changed', { statusId: read.statusId });
    return { previous: existing, next: await noteCatalogReturnIfNeeded(tx, await landParkedIfInbound(tx, updated!), actorId, hint?.returnNote, existing.statusId) };
  });
  scheduleWorkStatusSheet(result.previous, result.next);
  return result.next;
}

/** Parked + Catalog on a watched inbound status (K / E) is ready to assign. */
async function landParkedIfInbound(database: DbOrTx, submission: Submission): Promise<Submission> {
  if (submission.stage !== 'parked') return submission;
  const watched = await watchedProjectFor(database, submission.projectId);
  const { lane } = catalogReturnFromSync({
    statusId: submission.statusId,
    source: submission.source as { submission?: unknown; project?: unknown },
    watched,
  });
  const next = landFromParked({
    stage: submission.stage,
    reviewStatus: submission.reviewStatus,
    handoffStatus: submission.handoffStatus,
    pushedAt: submission.pushedAt,
    next: pipelineFromListState(lane, submission.reviewStatus),
  });
  if (!next || next.stage === 'parked') return submission;
  const [updated] = await database
    .update(submissions)
    .set({ stage: next.stage, reviewStatus: next.reviewStatus, handoffStatus: next.handoffStatus })
    .where(eq(submissions.id, submission.id))
    .returning();
  return updated!;
}

/** Catalog sent a submitted task back — reopen it on Platform returned and keep the why-note. */
export async function noteCatalogReturnIfNeeded(database: DbOrTx, submission: Submission, actorId: string | null, returnNote?: string | null, previousStatusId?: string | null): Promise<Submission> {
  const watched = await watchedProjectFor(database, submission.projectId);
  const { lane, detail } = catalogReturnFromSync({
    statusId: submission.statusId,
    source: submission.source as { submission?: unknown; project?: unknown },
    watched,
  });
  if (!detail.note && returnNote?.trim()) detail.note = returnNote.trim();
  const existing = parseCatalogReturn(submission.catalogReturn);
  if (
    !shouldEnqueueCatalogReturn({
      stage: submission.stage,
      handoffStatus: submission.handoffStatus,
      catalogLane: lane,
      catalogStatusId: submission.statusId,
      existing,
      previousStatusId,
      pushedAt: submission.pushedAt,
    })
  ) {
    return submission;
  }
  const events = await database.select().from(submissionEvents).where(eq(submissionEvents.submissionId, submission.id));
  const holder = lastRubricHolder({ currentId: submission.rubricAssigneeId, events });
  const now = new Date().toISOString();
  const catalogReturn = { ...detail, outcome: 'applied' as const };
  const [updated] = await database
    .update(submissions)
    .set({
      stage: 'rubric',
      handoffStatus: 'bounced',
      pushedAt: null,
      catalogReturn,
      ...(holder && holder !== submission.rubricAssigneeId ? { rubricAssigneeId: holder, rubricClaimedAt: now, lastClaimedAt: now } : {}),
    })
    .where(eq(submissions.id, submission.id))
    .returning();
  await recordEvent(database, submission.id, actorId, 'catalog_returned', {
    ...detail,
    previousPushedAt: submission.pushedAt,
    previousReceipt: submission.pushReceipt,
    rubricAssigneeId: holder ?? submission.rubricAssigneeId,
    reviewerId: submission.reviewerId,
  });
  return updated!;
}

export async function getSubmission(database: DbOrTx, id: string): Promise<Submission> {
  const row = (await database.select().from(submissions).where(eq(submissions.id, id)).limit(1))[0];
  if (!row) throw notFound('The submission');
  return row;
}

export async function getVisibleSubmission(database: DbOrTx, actor: Actor, id: string): Promise<Submission> {
  const row = await getSubmission(database, id);
  if (!canSeeSubmission(actor, row)) throw forbidden('This task is held by someone else.');
  return row;
}

/** List rows omit the raw Catalog `source` blob: it is large and carries contributor PII. */
export interface SubmissionListRow extends Omit<Submission, 'source'> {
  rubricAssigneeName: string | null;
  reviewerName: string | null;
  workState: WorkState;
  catalogStatusName: string | null;
  projectName: string;
  /** Catalog General Information → Hero deliverables. Safe on blinded claim slots. */
  heroDeliverable: string;
  /** True when this row is only a claim slot — catalog id stays hidden. */
  blinded: boolean;
  /** Why-text when Catalog sent this task back. */
  catalogReturnNote: string | null;
  /** Latest person doing work — not a Catalog refresh / last_seen_at sync. */
  lastInteractionAt: string | null;
}

const { source: _omittedSource, ...submissionListColumns } = getTableColumns(submissions);

export async function listSubmissions(actor: Actor, filter: { stage?: Submission['stage']; mine?: boolean; projectId?: string; q?: string; workState?: WorkState } = {}): Promise<SubmissionListRow[]> {
  const database = db();
  const assignee = alias(profiles, 'assignee');
  const reviewer = alias(profiles, 'reviewer');

  const conditions = [];
  if (filter.stage) conditions.push(eq(submissions.stage, filter.stage));
  if (filter.projectId) conditions.push(eq(submissions.projectId, filter.projectId));
  if (filter.mine) conditions.push(or(eq(submissions.rubricAssigneeId, actor.id), eq(submissions.reviewerId, actor.id)));
  const q = filter.q?.trim();
  if (q) conditions.push(or(ilike(submissions.title, `%${q}%`), ilike(submissions.catalogSubmissionId, `%${q}%`)));
  if (filter.workState === 'unassigned') {
    conditions.push(
      and(
        eq(submissions.stage, 'rubric'),
        isNull(submissions.rubricAssigneeId),
        sql`${submissions.reviewStatus} is distinct from 'changes_requested'`,
        sql`${submissions.handoffStatus} is distinct from 'bounced'`,
      ),
    );
  }
  if (filter.workState === 'preparing') {
    conditions.push(
      and(
        eq(submissions.stage, 'rubric'),
        isNotNull(submissions.rubricAssigneeId),
        sql`${submissions.reviewStatus} is distinct from 'changes_requested'`,
        sql`${submissions.handoffStatus} is distinct from 'bounced'`,
      ),
    );
  }
  if (filter.workState === 'in_review') conditions.push(eq(submissions.stage, 'review'));
  if (filter.workState === 'review_returned') {
    conditions.push(and(eq(submissions.stage, 'rubric'), eq(submissions.reviewStatus, 'changes_requested'), sql`${submissions.handoffStatus} is distinct from 'bounced'`));
  }
  if (filter.workState === 'stability') conditions.push(eq(submissions.stage, 'stability'));
  if (filter.workState === 'platform_returned') conditions.push(and(eq(submissions.handoffStatus, 'bounced'), sql`${submissions.stage} is distinct from 'done'`));
  if (filter.workState === 'handoff') conditions.push(and(eq(submissions.stage, 'handoff'), sql`${submissions.handoffStatus} is distinct from 'bounced'`));
  if (filter.workState === 'submitted') conditions.push(eq(submissions.stage, 'done'));
  if (filter.workState === 'other') conditions.push(eq(submissions.stage, 'parked'));
  if (!canOversee(actor)) {
    const visible = [];
    if (canCreateRubrics(actor)) {
      visible.push(eq(submissions.rubricAssigneeId, actor.id));
      visible.push(and(eq(submissions.stage, 'rubric'), isNull(submissions.rubricAssigneeId)));
    }
    if (canReview(actor)) {
      visible.push(eq(submissions.reviewerId, actor.id));
      visible.push(and(eq(submissions.stage, 'review'), isNull(submissions.reviewerId)));
    }
    if (visible.length === 0) return [];
    conditions.push(or(...visible));
  }

  const [rows, watches] = await Promise.all([
    database
      .select({
        submission: submissionListColumns,
        source: submissions.source,
        rubricAssigneeName: sql<string | null>`coalesce(${assignee.displayName}, ${assignee.email})`,
        reviewerName: sql<string | null>`coalesce(${reviewer.displayName}, ${reviewer.email})`,
      })
      .from(submissions)
      .leftJoin(assignee, eq(assignee.id, submissions.rubricAssigneeId))
      .leftJoin(reviewer, eq(reviewer.id, submissions.reviewerId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(submissions.lastSeenAt), desc(submissions.lastClaimedAt))
      .limit(500),
    database.select().from(watchedProjects),
  ]);
  const watchByProject = new Map(watches.map((item) => [item.projectId, item]));
  const statusName = (row: { projectId: string; statusId: string | null }) => {
    const names = readProjectStatuses(watchByProject.get(row.projectId)?.project ?? null);
    return names?.statuses.find((item) => item.id === row.statusId)?.name ?? null;
  };
  const latestById = new Map<string, string>();
  if (rows.length > 0) {
    const events = await database
      .select({
        submissionId: submissionEvents.submissionId,
        actorId: submissionEvents.actorId,
        action: submissionEvents.action,
        createdAt: submissionEvents.createdAt,
      })
      .from(submissionEvents)
      .where(inArray(submissionEvents.submissionId, rows.map((row) => row.submission.id)));
    for (const event of events) {
      if (!isUserInteraction(event)) continue;
      const have = latestById.get(event.submissionId);
      if (!have || event.createdAt > have) latestById.set(event.submissionId, event.createdAt);
    }
  }
  return rows
    .map((r) => {
      const held = r.submission.rubricAssigneeId === actor.id || r.submission.reviewerId === actor.id;
      const blinded = !canOversee(actor) && !held;
      // Reviewers pick by task and creator; rubric claim slots stay fully blind.
      const reviewSlot = blinded && r.submission.stage === 'review';
      const workState = workStateOf(r.submission);
      const watch = watchByProject.get(r.submission.projectId);
      return {
        ...r.submission,
        ...(blinded ? { catalogSubmissionId: reviewSlot ? r.submission.catalogSubmissionId : '', projectId: '' } : {}),
        rubricAssigneeName: blinded && !reviewSlot ? null : (r.rubricAssigneeName ?? null),
        reviewerName: blinded ? null : (r.reviewerName ?? null),
        workState,
        catalogStatusName: blinded ? null : statusName(r.submission),
        projectName: projectDisplayName(watch),
        heroDeliverable: heroDeliverableFromSource(r.source),
        blinded,
        catalogReturnNote: blinded ? null : (parseCatalogReturn(r.submission.catalogReturn)?.note ?? null),
        lastInteractionAt: latestById.get(r.submission.id) ?? r.submission.lastClaimedAt,
      };
    })
    .toSorted((left, right) => (right.lastInteractionAt ?? '').localeCompare(left.lastInteractionAt ?? ''));
}

/** Offer a blind claim without loading the brief. */
export async function peekClaim(actor: Actor, submissionId: string): Promise<{ seat: 'rubric' | 'review' } | null> {
  const row = await getSubmission(db(), submissionId);
  if (canSeeSubmission(actor, row)) return null;
  const seat = claimableSeat(actor, row, await capsFor(actor));
  return seat ? { seat } : null;
}

/* ─────────────────────────────────────────────── seats ── */

type Seat = AssignmentSeat;

const seatColumns = {
  rubric: { holder: submissions.rubricAssigneeId, claimedAt: submissions.rubricClaimedAt, key: 'rubricAssigneeId' as const, at: 'rubricClaimedAt' as const },
  review: { holder: submissions.reviewerId, claimedAt: submissions.reviewClaimedAt, key: 'reviewerId' as const, at: 'reviewClaimedAt' as const },
};

function seatStageError(seat: Seat): string {
  return seat === 'rubric'
    ? 'The rubric seat can only be assigned while the task is with the Rubric Team.'
    : 'The review seat can only be assigned while the task is in review.';
}

function seatTeamError(seat: Seat): string {
  const team = seatTeamLabel(seat);
  return `Assign the ${seat} seat to the ${team} or a ${team} member.`;
}

/** Take a free seat for yourself. Atomic: the row must still be unclaimed. */
export async function claimSeat(actor: Actor, submissionId: string, seat: Seat): Promise<Submission> {
  if (seat === 'rubric' && !canCreateRubrics(actor)) throw forbidden('Only rubric creators can claim the rubric seat.');
  if (seat === 'review' && !canReview(actor)) throw forbidden('Only reviewers can claim the review seat.');
  const column = seatColumns[seat];
  const now = new Date().toISOString();
  const result = await db().transaction(async (tx) => {
    const current = await getSubmission(tx, submissionId);
    if (seat === 'review' && current.stage !== 'review') throw conflict('This task is not in review yet.');
    if (seat === 'review' && isOwnRubricSeat(actor, current)) {
      throw forbidden('You cannot review a task whose rubric seat you hold.');
    }
    if (current[column.key] === actor.id) return { previous: current, next: current };
    const [updated] = await tx
      .update(submissions)
      .set({ [column.key]: actor.id, [column.at]: now, lastClaimedAt: now })
      .where(and(eq(submissions.id, submissionId), sql`${column.holder} is null`))
      .returning();
    if (!updated) throw conflict('Someone else claimed this task a moment ago.');
    await recordEvent(tx, submissionId, actor.id, `${seat}_claimed`, {});
    return { previous: current, next: updated };
  });
  scheduleWorkStatusSheet(result.previous, result.next);
  return result.next;
}

/** Clear a seat. Only PMs and admins — holders cannot drop work they claimed. */
export async function releaseSeat(actor: Actor, submissionId: string, seat: Seat): Promise<Submission> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can change assignment.');
  const column = seatColumns[seat];
  const result = await db().transaction(async (tx) => {
    const current = await getSubmission(tx, submissionId);
    if (!canAssignSeatAt(current, seat)) throw conflict(seatStageError(seat));
    const holder = current[column.key];
    if (holder === null) return { previous: current, next: current };
    const [updated] = await tx
      .update(submissions)
      .set({ [column.key]: null, lastClaimedAt: new Date().toISOString() })
      .where(and(eq(submissions.id, submissionId), eq(column.holder, holder)))
      .returning();
    if (!updated) throw conflict('The seat changed hands while you were releasing it.');
    await recordEvent(tx, submissionId, actor.id, `${seat}_released`, { previousHolder: holder });
    return { previous: current, next: updated };
  });
  scheduleWorkStatusSheet(result.previous, result.next);
  return result.next;
}

/** PMs hand a seat to a team member, or to the team pool (`userId` null). */
export async function assignSeat(actor: Actor, submissionId: string, seat: Seat, userId: string | null): Promise<Submission> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can assign seats.');
  const column = seatColumns[seat];
  const result = await db().transaction(async (tx) => {
    const current = await getSubmission(tx, submissionId);
    if (!canAssignSeatAt(current, seat)) throw conflict(seatStageError(seat));
    if (userId) {
      const target = (await tx.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
      if (!target || !target.isActive) throw invalid('That user is not active on the platform.');
      const grants = await tx.select().from(userRoles).where(eq(userRoles.userId, userId));
      if (!isEligibleAssignee(grants.map((g) => g.role), seat)) throw invalid(seatTeamError(seat));
      if (seat === 'review' && userId === current.rubricAssigneeId) {
        throw invalid('The rubric creator cannot take the review seat on their own task.');
      }
    }
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(submissions)
      .set({ [column.key]: userId, [column.at]: userId ? now : null, lastClaimedAt: now })
      .where(eq(submissions.id, submissionId))
      .returning();
    if (!updated) throw notFound('The submission');
    await recordEvent(tx, submissionId, actor.id, `${seat}_assigned`, { userId });
    return { previous: current, next: updated };
  });
  scheduleWorkStatusSheet(result.previous, result.next);
  return result.next;
}

/* ─────────────────────────────────────── PM overview ── */

export interface ClaimsOverviewRow {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  rubricSeats: { submissionId: string; catalogSubmissionId: string; title: string; heroDeliverable: string; stage: string; claimedAt: string | null; landedAt: string }[];
  reviewSeats: { submissionId: string; catalogSubmissionId: string; title: string; heroDeliverable: string; stage: string; claimedAt: string | null; landedAt: string }[];
}

/** Who holds what, for PMs. */
export async function claimsOverview(actor: Actor): Promise<ClaimsOverviewRow[]> {
  if (!canOversee(actor)) throw forbidden('Only PMs, admins, and observers can see the claims overview.');
  const database = db();
  const [people, roleRows, held] = await Promise.all([
    database.select().from(profiles).where(eq(profiles.isActive, true)).orderBy(profiles.email),
    database.select().from(userRoles),
    database.select().from(submissions).where(or(isNotNull(submissions.rubricAssigneeId), isNotNull(submissions.reviewerId))),
  ]);

  const roles = new Map<string, string[]>();
  for (const r of roleRows) roles.set(r.userId, [...(roles.get(r.userId) ?? []), r.role]);

  return people.map((p) => ({
    userId: p.id,
    name: p.displayName ?? p.email,
    email: p.email,
    roles: roles.get(p.id) ?? [],
    rubricSeats: held
      .filter((s) => s.rubricAssigneeId === p.id)
      .map((s) => ({ submissionId: s.id, catalogSubmissionId: s.catalogSubmissionId, title: s.title, heroDeliverable: heroDeliverableFromSource(s.source), stage: s.stage, claimedAt: s.rubricClaimedAt, landedAt: s.landedAt })),
    reviewSeats: held
      .filter((s) => s.reviewerId === p.id)
      .map((s) => ({ submissionId: s.id, catalogSubmissionId: s.catalogSubmissionId, title: s.title, heroDeliverable: heroDeliverableFromSource(s.source), stage: s.stage, claimedAt: s.reviewClaimedAt, landedAt: s.landedAt })),
  }));
}

/* ─────────────────────────────────────── watched projects ── */

export async function watchedProjectFor(database: DbOrTx, projectId: string) {
  return (await database.select().from(watchedProjects).where(eq(watchedProjects.projectId, projectId)).limit(1))[0] ?? null;
}
