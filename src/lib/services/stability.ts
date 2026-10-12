import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { stabilityAcceptances, stabilityFlipNotes, stabilityPasses, submissions, type FlipNoteAction, type RubricStatement, type StabilityAcceptance, type StabilityFlipNote, type StabilityPass } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { stabilityGate, type StabilityGate } from '@/domain/gates';
import { holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import { conflict, forbidden, invalid } from './errors';
import { submittedCalibration } from './review';
import { currentRubric, statementsOf } from './rubric';
import { scheduleReap } from '@/lib/ai/reaper';
import { scheduleWorkStatusSheet } from '@/lib/sheets/workStatus';
import { getSubmission, recordEvent } from './submissions';

/**
 * Stability = three independent autorater passes over the AI output with the
 * approved rubric. A *group* is one run of three. The gate is pure
 * (`domain/gates`); acceptance is an explicit human act recorded with the
 * scores it accepted.
 */

export interface StabilityView {
  groupId: string | null;
  passes: StabilityPass[];
  gate: StabilityGate | null;
  accepted: StabilityAcceptance | null;
  calibrationPercent: number | null;
  calibrationGateActive: boolean;
  flipNotes: StabilityFlipNote[];
}

export async function latestGroup(database: DbOrTx, rubricId: string): Promise<StabilityPass[]> {
  const newest = (await database.select({ groupId: stabilityPasses.groupId }).from(stabilityPasses).where(eq(stabilityPasses.rubricId, rubricId)).orderBy(desc(stabilityPasses.createdAt)).limit(1))[0];
  if (!newest) return [];
  return database.select().from(stabilityPasses).where(and(eq(stabilityPasses.rubricId, rubricId), eq(stabilityPasses.groupId, newest.groupId))).orderBy(stabilityPasses.passIndex);
}

export async function stabilityView(
  database: DbOrTx,
  rubricId: string,
  options: { calibrationGateActive?: boolean; statements?: Pick<RubricStatement, 'id'>[]; calibration?: { scorePercent: number } | null } = {},
): Promise<StabilityView> {
  const [passes, statements, calibration] = await Promise.all([
    latestGroup(database, rubricId),
    options.statements ?? statementsOf(database, rubricId),
    options.calibration !== undefined ? options.calibration : submittedCalibration(database, rubricId),
  ]);
  const calibrationGateActive = options.calibrationGateActive ?? calibration != null;
  const groupId = passes[0]?.groupId ?? null;
  const gate = passes.length
    ? stabilityGate({
        passes: passes.map((p) => ({ answers: p.answers, errors: p.errors })),
        statementIds: statements.map((s) => s.id),
        calibrationPercent: calibration?.scorePercent ?? null,
        calibrationGateActive,
      })
    : null;
  const [accepted, flipNotes] = groupId
    ? await Promise.all([
        database.select().from(stabilityAcceptances).where(and(eq(stabilityAcceptances.rubricId, rubricId), eq(stabilityAcceptances.groupId, groupId))).limit(1).then((rows) => rows[0] ?? null),
        database.select().from(stabilityFlipNotes).where(and(eq(stabilityFlipNotes.rubricId, rubricId), eq(stabilityFlipNotes.groupId, groupId))),
      ])
    : [null, [] as StabilityFlipNote[]];
  return { groupId, passes, gate, accepted, calibrationPercent: calibration?.scorePercent ?? null, calibrationGateActive, flipNotes };
}

export async function acceptStability(actor: Actor, submissionId: string, groupId: string): Promise<void> {
  const previous = await getSubmission(db(), submissionId);
  await db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
    if (submission.stage !== 'stability') throw conflict('The task is not in the stability stage.');
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw conflict('There is no rubric.');
    const view = await stabilityView(tx, rubric.id);
    if (view.groupId !== groupId) throw conflict('A newer stability run exists; accept that one.');
    if (!view.gate?.ok) throw conflict(`Stability has not passed: ${view.gate?.reasons.join(' ') ?? 'no passes yet.'}`);
    if (view.accepted) return;
    const calibration = await submittedCalibration(tx, rubric.id);
    await tx.insert(stabilityAcceptances).values({
      rubricId: rubric.id,
      groupId,
      acceptedBy: actor.id,
      scores: view.gate.scores,
      spread: view.gate.spread ?? 0,
      calibrationId: calibration?.id ?? null,
      basis: { rubricRevision: rubric.revision, passIds: view.passes.map((p) => p.id), calibrationPercent: view.calibrationPercent },
    });
    await tx.update(submissions).set({ stage: 'handoff', handoffStatus: 'stability_pass' }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, 'stability_accepted', { groupId, scores: view.gate.scores, spread: view.gate.spread });
  });
  scheduleWorkStatusSheet(previous, await getSubmission(db(), submissionId));
  scheduleReap();
}

/** Record that the creator looked at a flip (or asked for a rewrite of that seat). */
export async function noteFlip(actor: Actor, submissionId: string, input: { groupId: string; statementId: string; action: FlipNoteAction; note: string }): Promise<void> {
  if (input.note.trim().length < 5) throw invalid('Say why this flip is acceptable, or what should change (at least 5 characters).');
  await db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
    if (submission.stage !== 'stability') throw conflict('The task is not in the stability stage.');
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw conflict('There is no rubric.');
    const view = await stabilityView(tx, rubric.id);
    if (view.groupId !== input.groupId) throw conflict('A newer stability run exists.');
    if (!view.gate?.flips.includes(input.statementId)) throw conflict('That statement did not flip in this run.');
    const existing = (
      await tx
        .select({ id: stabilityFlipNotes.id })
        .from(stabilityFlipNotes)
        .where(and(eq(stabilityFlipNotes.groupId, input.groupId), eq(stabilityFlipNotes.statementId, input.statementId)))
        .limit(1)
    )[0];
    if (existing) {
      await tx
        .update(stabilityFlipNotes)
        .set({ action: input.action, note: input.note.trim(), createdBy: actor.id, createdAt: new Date().toISOString() })
        .where(eq(stabilityFlipNotes.id, existing.id));
    } else {
      await tx.insert(stabilityFlipNotes).values({ rubricId: rubric.id, groupId: input.groupId, statementId: input.statementId, action: input.action, note: input.note.trim(), createdBy: actor.id });
    }
    await recordEvent(tx, submissionId, actor.id, input.action === 'rewrite_requested' ? 'stability_rewrite_requested' : 'stability_flip_acknowledged', { statementId: input.statementId, groupId: input.groupId });
  });
}

/**
 * Send the task back to the rubric stage so the creator can rewrite flipped
 * seats. Stability results stay on the previous group for comparison.
 */
export async function reopenRubricFromStability(actor: Actor, submissionId: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw invalid('Say why the rubric is reopening.');
  const previous = await getSubmission(db(), submissionId);
  await db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
    if (submission.stage !== 'stability') throw conflict('The task is not in the stability stage.');
    await tx.update(submissions).set({ stage: 'rubric', reviewStatus: 'changes_requested' }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, 'stability_reopened_rubric', { reason: reason.trim() });
  });
  scheduleWorkStatusSheet(previous, await getSubmission(db(), submissionId));
}
