import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { calibrations, reviewFeedback, submissions, type Calibration } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { mergeReviewDraft, REVIEW_NOTE_MIN_CHARS } from '@/domain/review';
import { calibrationInBand, CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, EVIDENCE_MIN_CHARS, scoreBreakdown, stabilityGate } from '@/domain/gates';
import { countFamilies, quotaSpread } from '@/domain/rubric';
import { holdsReviewSeat, holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import { conflict, forbidden, invalid, notFound } from './errors';
import { pruneCalibrations, pruneReviewFeedback } from './retention';
import { listAiOutputs } from './files';
import { currentRubric, goldenState, statementsOf } from './rubric';
import { latestGroup } from './stability';
import { scheduleWorkStatusSheet } from '@/lib/sheets/workStatus';
import { handoffAfterContinue } from '@/domain/workState';
import { getSubmission, recordEvent } from './submissions';

/**
 * Review = the human AI evaluation (calibration) plus a decision.
 *
 * The reviewer answers every statement against the AI output by hand. The
 * score must land in the 20–50% band before the task can be approved; a
 * band miss is a rubric problem, so the decision goes back to the creator
 * as "changes requested" with the reviewer's notes.
 */

export async function sendToReview(actor: Actor, submissionId: string): Promise<void> {
  const previous = await getSubmission(db(), submissionId);
  await db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
    if (submission.stage !== 'rubric') throw conflict(`The task is already in ${submission.stage}.`);
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw conflict('Generate or write a rubric first.');
    const statements = await statementsOf(tx, rubric.id);
    const spread = quotaSpread(countFamilies(statements));
    if (!spread.ready) throw conflict(`Seat the rubric at 5 Format, 15 Content, 30 Visual first. ${spread.warning}`);
    const golden = await goldenState(tx, rubric.id, statements);
    if (!golden.gate.ok) throw conflict(`Golden must grade 100% before review: ${golden.gate.reasons.join(' ')}`);
    const preview = stabilityGate({
      passes: await latestGroup(tx, rubric.id),
      statementIds: statements.map((row) => row.id),
      calibrationGateActive: false,
    });
    if (preview.complete && !preview.inBand) {
      throw conflict(`Stability must score between ${CALIBRATION_MIN_PERCENT}% and ${CALIBRATION_MAX_PERCENT}% before sending to review.`);
    }
    const outputs = await listAiOutputs(tx, submissionId);
    if (outputs.length === 0) throw conflict('Upload the AI output before sending the task to review.');
    await tx
      .update(submissions)
      .set({ stage: 'review', reviewStatus: 'pending', reviewRubricId: rubric.id, handoffStatus: handoffAfterContinue(submission.handoffStatus) })
      .where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, 'sent_to_review', { rubricId: rubric.id, revision: rubric.revision, statements: statements.length });
  });
  const next = await getSubmission(db(), submissionId);
  scheduleWorkStatusSheet(previous, next);
}

export async function latestCalibration(database: DbOrTx, rubricId: string): Promise<Calibration | null> {
  return (await database.select().from(calibrations).where(eq(calibrations.rubricId, rubricId)).orderBy(desc(calibrations.createdAt)).limit(1))[0] ?? null;
}

export async function submittedCalibration(database: DbOrTx, rubricId: string): Promise<Calibration | null> {
  return (await database.select().from(calibrations).where(and(eq(calibrations.rubricId, rubricId), eq(calibrations.submitted, true))).orderBy(desc(calibrations.createdAt)).limit(1))[0] ?? null;
}

/**
 * Saves the reviewer's answers. Drafts may be partial; `submit` requires
 * every statement answered. A draft overwrites the current unsaved row;
 * only current plus one backup are kept.
 */
export async function saveCalibration(actor: Actor, submissionId: string, input: { answers: Record<string, boolean>; evidence: Record<string, string>; submit: boolean }): Promise<Calibration> {
  return db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsReviewSeat(actor, submission)) throw forbidden('You do not hold the review seat on this task.');
    if (submission.stage !== 'review') throw conflict('The task is not in review.');
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw conflict('Generate or write a rubric first.');
    if (!submission.reviewRubricId) {
      await tx.update(submissions).set({ reviewRubricId: rubric.id }).where(eq(submissions.id, submissionId));
    } else if (rubric.id !== submission.reviewRubricId) {
      throw conflict('The rubric changed since review started. Ask the creator to resend.');
    }
    const statements = await statementsOf(tx, rubric.id);
    const ids = new Set(statements.map((s) => s.id));
    const answers: Record<string, boolean> = {};
    for (const [id, verdict] of Object.entries(input.answers)) if (ids.has(id) && typeof verdict === 'boolean') answers[id] = verdict;
    const evidence: Record<string, string> = {};
    for (const [id, text] of Object.entries(input.evidence)) if (ids.has(id) && typeof text === 'string') evidence[id] = text.trim().slice(0, 1000);

    const latest = await latestCalibration(tx, rubric.id);
    const incoming = { answers, evidence };
    const draft = !input.submit && latest && !latest.submitted ? mergeReviewDraft(latest, incoming) : incoming;
    const score = scoreBreakdown(draft.answers, statements.map((s) => s.id));
    if (input.submit && score.unanswered > 0) throw invalid(`${score.unanswered} statement(s) are still unanswered.`);
    if (input.submit) {
      const thin = statements.filter((s) => answers[s.id] !== undefined && (evidence[s.id] ?? '').length < EVIDENCE_MIN_CHARS);
      if (thin.length > 0) throw invalid(`${thin.length} statement(s) need an observation of at least ${EVIDENCE_MIN_CHARS} characters.`);
    }
    const outputs = await listAiOutputs(tx, submissionId);
    const values = {
      rubricId: rubric.id,
      reviewerId: actor.id,
      answers: draft.answers,
      evidence: draft.evidence,
      scorePercent: score.percent ?? 0,
      submitted: input.submit,
      basis: { rubricRevision: rubric.revision, statementIds: statements.map((s) => s.id), aiOutputIds: outputs.map((o) => o.id), aiOutputShas: outputs.map((o) => o.sha256) },
    };
    const [row] = latest && !latest.submitted
      ? await tx.update(calibrations).set(values).where(eq(calibrations.id, latest.id)).returning()
      : await tx.insert(calibrations).values(values).returning();
    await pruneCalibrations(tx, rubric.id);
    await recordEvent(tx, submissionId, actor.id, input.submit ? 'calibration_submitted' : 'calibration_saved', { scorePercent: score.percent, answered: score.yes + score.no });
    return row!;
  });
}

export async function decideReview(actor: Actor, submissionId: string, decision: 'approved' | 'changes_requested', feedback: string): Promise<void> {
  const previous = await getSubmission(db(), submissionId);
  await db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    if (!holdsReviewSeat(actor, submission)) throw forbidden('You do not hold the review seat on this task.');
    if (submission.stage !== 'review') throw conflict('The task is not in review.');
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw notFound('The rubric');
    // Approve uses the latest complete pass — including a draft the reviewer
    // just rescored after the rubric came back — not an older submitted row.
    const statements = await statementsOf(tx, rubric.id);
    const latest = await latestCalibration(tx, rubric.id);
    const latestComplete = Boolean(latest && statements.every((s) => typeof latest.answers[s.id] === 'boolean'));
    let calibration = latestComplete ? latest : await submittedCalibration(tx, rubric.id);
    if (decision === 'approved') {
      if (!latestComplete || !latest) throw conflict('Save every Human Calibration answer before approving.');
      if (!latest.submitted) {
        const [locked] = await tx.update(calibrations).set({ submitted: true }).where(eq(calibrations.id, latest.id)).returning();
        calibration = locked ?? latest;
      }
      if (!calibration) throw conflict('Save every Human Calibration answer before approving.');
      if (!calibrationInBand(calibration.scorePercent)) {
        throw conflict(`The AI scored ${calibration.scorePercent.toFixed(1)}%; approval needs ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}%. Request changes so the creator can tighten or relax the rubric.`);
      }
    } else if (feedback.trim().length < REVIEW_NOTE_MIN_CHARS) {
      throw invalid(`Tell the creator what to change (at least ${REVIEW_NOTE_MIN_CHARS} characters).`);
    }

    await tx.insert(reviewFeedback).values({ submissionId, rubricId: rubric.id, reviewerId: actor.id, decision, feedback: feedback.trim(), calibrationId: calibration?.id ?? null });
    await pruneReviewFeedback(tx, submissionId);
    await tx
      .update(submissions)
      .set(
        decision === 'approved'
          ? { stage: 'stability', reviewStatus: 'approved', handoffStatus: handoffAfterContinue(submission.handoffStatus) }
          : { stage: 'rubric', reviewStatus: 'changes_requested', rubricAssigneeId: submission.rubricAssigneeId, handoffStatus: handoffAfterContinue(submission.handoffStatus) },
      )
      .where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, decision === 'approved' ? 'review_approved' : 'review_changes_requested', { calibrationId: calibration?.id ?? null, scorePercent: calibration?.scorePercent ?? null });
  });
  const next = await getSubmission(db(), submissionId);
  scheduleWorkStatusSheet(previous, next);
}

export async function feedbackFor(database: DbOrTx, submissionId: string) {
  return database.select().from(reviewFeedback).where(eq(reviewFeedback.submissionId, submissionId)).orderBy(desc(reviewFeedback.createdAt));
}
