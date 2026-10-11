import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissions, type Submission } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { handoffGates, handoffTransitionGate, type HandoffGates, type HandoffTarget } from '@/domain/gates';
import { holdsRubricSeat, isController, type Actor } from '@/lib/auth/permissions';
import { fetchSubmission, saveSubmissionValues, transitionSubmission } from '@/lib/catalog/client';
import { catalogRubricItems, catalogTaskPerformance } from '@/lib/catalog/export';
import { ProjectPayload, readCatalogSubmission } from '@/lib/catalog/read';
import { scheduleReap } from '@/lib/ai/reaper';
import { isLivePushLease } from '@/domain/pushLease';
import { conflict, forbidden, invalid, ServiceError } from './errors';
import { submittedCalibration } from './review';
import { currentRubric, goldenState, statementsOf } from './rubric';
import { stabilityView } from './stability';
import { getSubmission, readSource, recordEvent, watchedProjectFor } from './submissions';

/**
 * Handoff: the PM-facing status ladder and the push into the Catalog.
 *
 * Internal ladder (unchanged from the existing platform):
 *   ready_for_review → bounced | stability_pass → final_review_pass → client_visible
 * `client_visible` is set by the push itself, never requested.
 *
 * The push writes `rubrics`, `prompt` and `taskPerformance` into the
 * submission's form values and then walks the project workflow forward from
 * the watched project's work status to its handoff status, one legal move at
 * a time. The Catalog remains the judge of each move.
 */

export interface HandoffView {
  gates: HandoffGates;
  goldenPercent: number | null;
  calibrationPercent: number | null;
  stabilityScores: number[] | null;
  status: Submission['handoffStatus'];
  pushedAt: string | null;
}

export async function handoffView(database: DbOrTx, submission: Submission): Promise<HandoffView> {
  const rubric = await currentRubric(database, submission.id);
  if (!rubric) {
    return { gates: handoffGates({ golden: null, calibrationPercent: null, stability: null, stabilityAccepted: false }), goldenPercent: null, calibrationPercent: null, stabilityScores: null, status: submission.handoffStatus, pushedAt: submission.pushedAt };
  }
  const statements = await statementsOf(database, rubric.id);
  const golden = await goldenState(database, rubric.id, statements);
  const calibration = await submittedCalibration(database, rubric.id);
  const stability = await stabilityView(database, rubric.id);
  const gates = handoffGates({ golden: golden.gate, calibrationPercent: calibration?.scorePercent ?? null, stability: stability.gate, stabilityAccepted: stability.accepted !== null });
  return {
    gates,
    goldenPercent: golden.gate.percent,
    calibrationPercent: calibration?.scorePercent ?? null,
    stabilityScores: stability.gate?.complete ? stability.gate.scores : null,
    status: submission.handoffStatus,
    pushedAt: submission.pushedAt,
  };
}

const LADDER: Record<HandoffTarget, Submission['handoffStatus'][]> = {
  ready_for_review: [null, 'bounced'],
  bounced: ['ready_for_review', 'stability_pass'],
  stability_pass: ['ready_for_review', 'bounced'],
  final_review_pass: ['stability_pass'],
};

export async function setHandoffStatus(actor: Actor, submissionId: string, target: HandoffTarget, reason: string): Promise<Submission> {
  return db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    const controllerOnly = target === 'final_review_pass' || target === 'bounced';
    if (controllerOnly ? !isController(actor) : !holdsRubricSeat(actor, submission)) throw forbidden('You may not make that handoff move.');
    if (submission.handoffStatus === 'client_visible') throw conflict('This task has already been delivered to the Catalog.');
    if (!LADDER[target].includes(submission.handoffStatus)) throw conflict(`Cannot move from ${submission.handoffStatus ?? 'start'} to ${target}.`);
    if (target === 'bounced' && reason.trim().length < 5) throw invalid('Say why the task is bounced.');
    const view = await handoffView(tx, submission);
    const gate = handoffTransitionGate(target, view.gates);
    if (!gate.ok) throw conflict(gate.error);
    const [updated] = await tx
      .update(submissions)
      .set({ handoffStatus: target, handoffBasis: { by: actor.id, at: new Date().toISOString(), reason: reason.trim(), gates: view.gates, goldenPercent: view.goldenPercent, calibrationPercent: view.calibrationPercent, stabilityScores: view.stabilityScores }, ...(target === 'bounced' ? { stage: 'rubric' as const } : {}) })
      .where(eq(submissions.id, submissionId))
      .returning();
    await recordEvent(tx, submissionId, actor.id, `handoff_${target}`, { reason: reason.trim() });
    return updated!;
  });
}

/* ───────────────────────────────────────────── Catalog push ── */

const FORWARD = ['next', 'approve', 'submit', 'resubmit', 'assign'];

/** Shortest forward path through the project workflow. */
export function routeForward(project: unknown, from: string, to: string): { to: string; trigger: string }[] | null {
  const parsed = ProjectPayload.safeParse(project);
  if (!parsed.success) return null;
  const edges = (parsed.data.workflow?.transitions ?? []).filter((e) => e.from && e.to && FORWARD.includes(e.trigger ?? ''));
  const queue: { at: string; path: { to: string; trigger: string }[] }[] = [{ at: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { at, path } = queue.shift()!;
    if (at === to) return path;
    for (const edge of edges) {
      if (edge.from !== at || seen.has(edge.to!)) continue;
      seen.add(edge.to!);
      queue.push({ at: edge.to!, path: [...path, { to: edge.to!, trigger: edge.trigger ?? '' }] });
    }
  }
  return null;
}

export interface PushResult {
  rubricItems: number;
  moves: string[];
}

export async function pushToCatalog(actor: Actor, submissionId: string): Promise<PushResult> {
  const database = db();
  const submission = await getSubmission(database, submissionId);
  if (!(holdsRubricSeat(actor, submission) || isController(actor))) throw forbidden('You may not push this task.');
  if (submission.handoffStatus !== 'final_review_pass') throw conflict('The task must reach "final review pass" before it is pushed.');
  if (submission.pushedAt) throw conflict('This task was already pushed.');
  if (isLivePushLease(submission.pushReceipt)) throw conflict('A push is already in progress for this task.');

  const view = await handoffView(database, submission);
  if (!(view.gates.golden && view.gates.calibration && view.gates.stability)) throw conflict(view.gates.reasons.join(' '));

  const rubric = await currentRubric(database, submissionId);
  if (!rubric) throw conflict('There is no rubric.');
  const statements = await statementsOf(database, rubric.id);
  const golden = await goldenState(database, rubric.id, statements);
  const watched = await watchedProjectFor(database, submission.projectId);
  if (!watched || !watched.handoffStatusId) throw conflict('This project has no handoff status configured. Ask a PM to set it under Settings → Projects.');

  const recoveredEarly = await reconcileLocalPush(database, actor, submission, watched.handoffStatusId);
  if (recoveredEarly) return recoveredEarly;

  if (submission.pushReceipt && !isLivePushLease(submission.pushReceipt)) {
    await database.update(submissions).set({ pushReceipt: null }).where(and(eq(submissions.id, submissionId), sql`${submissions.pushedAt} is null`));
  }

  // Take a short push lease so two clicks cannot both push. Expired leases are cleared above.
  const leased = await database
    .update(submissions)
    .set({ pushReceipt: { leaseBy: actor.id, leaseAt: new Date().toISOString() } })
    .where(and(eq(submissions.id, submissionId), sql`${submissions.pushReceipt} is null`))
    .returning({ id: submissions.id });
  if (leased.length === 0) throw conflict('A push is already in progress for this task.');

  let catalogTouched = false;
  try {
    const fresh = await fetchSubmission(submission.catalogSubmissionId);
    if (!fresh.ok) throw new ServiceError(502, fresh.error);
    const read = readCatalogSubmission(fresh.submission, fresh.project);
    if (!read) throw new ServiceError(502, 'The Catalog payload could not be read.');

    const items = catalogRubricItems(
      statements.map((s) => ({ id: s.id, statement: s.statement, family: s.family, position: s.position, answer: golden.verdicts[s.id] === false ? 'No' : 'Yes' })),
      fresh.project,
    );
    if (!items.ok) throw invalid(items.error);
    const performance = catalogTaskPerformance({ goldenPercent: view.goldenPercent, calibrationPercent: view.calibrationPercent, stabilityScores: view.stabilityScores }, fresh.project, read.values['taskPerformance']);
    if (!performance) throw conflict('The task performance summary is incomplete; the push was not made.');

    const values: Record<string, unknown> = { ...read.values, rubrics: items.items, taskPerformance: performance };
    if (rubric.seeds.length && typeof read.values['prompt'] !== 'string') values['prompt'] = rubric.seeds.join('\n');

    const saved = await saveSubmissionValues(submission.catalogSubmissionId, read.projectId, values);
    if (!saved.ok) throw new ServiceError(saved.status === 400 ? 422 : 502, saved.error);
    catalogTouched = true;

    const moves: string[] = [];
    let at = read.statusId ?? watched.workStatusId;
    const route = routeForward(fresh.project, at, watched.handoffStatusId);
    if (route === null) throw conflict(`No forward path exists from the current Catalog status to the handoff status.`);
    for (const step of route) {
      const moved = await transitionSubmission(submission.catalogSubmissionId, read.projectId, step.to, undefined);
      if (!moved.ok) throw new ServiceError(502, `Values were saved but the move to ${step.to} failed: ${moved.error}`);
      moves.push(step.to);
      at = step.to;
    }

    await database.transaction(async (tx) => {
      await tx
        .update(submissions)
        .set({ handoffStatus: 'client_visible', stage: 'done', pushedAt: new Date().toISOString(), statusId: at, pushReceipt: { by: actor.id, at: new Date().toISOString(), rubricItems: items.items.length, moves, performance } })
        .where(eq(submissions.id, submissionId));
      await recordEvent(tx, submissionId, actor.id, 'pushed_to_catalog', { rubricItems: items.items.length, moves });
    });
    scheduleReap();
    return { rubricItems: items.items.length, moves };
  } catch (error) {
    if (catalogTouched) {
      const recovered = await reconcileLocalPush(database, actor, submission, watched.handoffStatusId);
      if (recovered) return recovered;
    }
    await database.update(submissions).set({ pushReceipt: null }).where(and(eq(submissions.id, submissionId), sql`${submissions.pushedAt} is null`));
    await recordEvent(database, submissionId, actor.id, 'push_failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** If the Catalog already has the handoff status, finish the local row so a retry is not a dead end. */
async function reconcileLocalPush(
  database: ReturnType<typeof db>,
  actor: Actor,
  submission: Submission,
  handoffStatusId: string,
): Promise<PushResult | null> {
  const fresh = await fetchSubmission(submission.catalogSubmissionId);
  if (!fresh.ok) return null;
  const read = readCatalogSubmission(fresh.submission, fresh.project);
  if (!read || read.statusId !== handoffStatusId) return null;
  const items = Array.isArray(read.values['rubrics']) ? read.values['rubrics'] : [];
  await database.transaction(async (tx) => {
    await tx
      .update(submissions)
      .set({
        handoffStatus: 'client_visible',
        stage: 'done',
        pushedAt: new Date().toISOString(),
        statusId: read.statusId,
        pushReceipt: { by: actor.id, at: new Date().toISOString(), rubricItems: items.length, moves: [handoffStatusId], recovered: true },
      })
      .where(and(eq(submissions.id, submission.id), sql`${submissions.pushedAt} is null`));
    await recordEvent(tx, submission.id, actor.id, 'pushed_to_catalog', { recovered: true, rubricItems: items.length });
  });
  scheduleReap();
  return { rubricItems: items.length, moves: [handoffStatusId] };
}

export { readSource };
