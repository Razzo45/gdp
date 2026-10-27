import 'server-only';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { isUserInteraction } from '@/domain/dashboard';
import { acceptanceCriteriaText } from '@/domain/fileScope';
import { tightenReportOf, type TightenReport } from '@/domain/tighten';
import { jobs as jobsTable, profiles, submissionEvents, type AiOutputFile, type Job, type RubricStatement, type Submission, type SubmissionEvent } from '@/db/schema';
import { progressKeyOf, type StatusPulse } from '@/domain/freshness';
import { canSubmitToDataPlatform, type GoldenGate, type HandoffGates, type StabilityGate, type Verdict } from '@/domain/gates';
import { familyQuotas, RUBRIC_TARGET } from '@/domain/rubric';
import { capsFor } from '@/lib/auth/workMode';
import { canChangeAiOutputs, canRunStability, claimableSeat, holdsReviewSeat, holdsRubricSeat, isController, isOwnRubricSeat, taskLens, type Actor, type TaskLens } from '@/lib/auth/permissions';
import { parseCatalogReturn } from '@/domain/catalogReturn';
import { heroDeliverableFromSource } from '@/lib/catalog/read';
import type { CatalogField, CatalogFile } from '@/lib/catalog/types';
import { jobsForSubmission } from '@/lib/jobs/queue';
import { listAiOutputs } from './files';
import { handoffView } from './handoff';
import { feedbackFor, latestCalibration, submittedCalibration } from './review';
import { currentRubric, goldenState, statementsOf } from './rubric';
import { stabilityView } from './stability';
import { getVisibleSubmission, readSource } from './submissions';

/**
 * Everything the task page needs, in one serialisable object. The page
 * renders it on the server; the client reloads it after an action or
 * when a status pulse sees a stage, seat, or job-status change.
 */

export interface SubmissionView {
  submission: Pick<Submission, 'id' | 'catalogSubmissionId' | 'projectId' | 'statusId' | 'title' | 'stage' | 'landedAt' | 'lastSeenAt' | 'upstreamChangedAt' | 'lastClaimedAt' | 'rubricAssigneeId' | 'rubricClaimedAt' | 'reviewerId' | 'reviewClaimedAt' | 'reviewStatus' | 'handoffStatus' | 'pushedAt' | 'revision'>;
  people: Record<string, { name: string; email: string }>;
  brief: { projectName: string; statusName: string | null; author: string | null; heroDeliverable: string; fields: CatalogField[]; hasAcceptanceCriteria: boolean; inputFiles: CatalogFile[]; goldenFiles: CatalogFile[] };
  rubric: { id: string; version: number; revision: number; seeds: string[]; generation: Record<string, unknown>; statements: RubricStatement[]; quotas: Record<string, number>; target: number } | null;
  golden: { verdicts: Record<string, Verdict>; evidence: Record<string, string>; errors: Record<string, string>; sources: Record<string, 'ai' | 'human' | 'stale'>; audit: Record<string, { ai?: { verdict: boolean | null; evidence: string; model: string | null }; human?: { verdict: boolean | null; evidence: string } }>; gate: GoldenGate } | null;
  aiOutputs: AiOutputFile[];
  review: { latest: { id: string; answers: Record<string, boolean>; evidence: Record<string, string>; scorePercent: number; submitted: boolean; reviewerId: string | null; createdAt: string } | null; submittedPercent: number | null; feedback: { decision: string; feedback: string; reviewerId: string | null; createdAt: string }[] };
  stability: { groupId: string | null; passes: { passIndex: number; answers: Record<string, boolean | null>; evidence: Record<string, string>; errors: Record<string, string>; scorePercent: number | null; model: string | null; createdAt: string; basis: { statementsAt?: string } }[]; gate: StabilityGate | null; acceptedAt: string | null; calibrationGateActive: boolean; flipNotes: { statementId: string; action: string; note: string }[] } | null;
  handoff: { gates: HandoffGates; goldenPercent: number | null; calibrationPercent: number | null; stabilityScores: number[] | null };
  jobs: Pick<Job, 'id' | 'kind' | 'status' | 'progress' | 'error' | 'createdAt' | 'startedAt' | 'finishedAt' | 'attempts'>[];
  helper: { id: string; status: Job['status']; progress: Job['progress']; error: string | null; result: TightenReport | null } | null;
  events: Pick<SubmissionEvent, 'id' | 'actorId' | 'action' | 'detail' | 'createdAt'>[];
  catalogReturnNote: string | null;
  can: {
    lens: TaskLens;
    editRubric: boolean;
    holdsRubricSeat: boolean;
    runStability: boolean;
    runGolden: boolean;
    review: boolean;
    control: boolean;
    claimRubric: boolean;
    claimReview: boolean;
    push: boolean;
    seeHistory: boolean;
    seeJobsLog: boolean;
    seeRunProgress: boolean;
    seeReviewPanel: boolean;
    seeRubricEditor: boolean;
    seeGoldenFiles: boolean;
    seeStability: boolean;
    seeHandoff: boolean;
    seeAiUpload: boolean;
    changeAiOutputs: boolean;
    seeScoreGolden: boolean;
    seeScoreStability: boolean;
  };
}

export async function submissionView(actor: Actor, id: string): Promise<SubmissionView> {
  const database = db();
  const submission = await getVisibleSubmission(database, actor, id);
  const source = readSource(submission);
  const [rubric, aiOutputs, feedback, jobs, events, helperJob] = await Promise.all([
    currentRubric(database, id),
    listAiOutputs(database, id),
    feedbackFor(database, id),
    jobsForSubmission(database, id, 12),
    database.select().from(submissionEvents).where(eq(submissionEvents.submissionId, id)).orderBy(desc(submissionEvents.createdAt)).limit(40),
    database
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.submissionId, id), eq(jobsTable.kind, 'rubric_helper')))
      .orderBy(desc(jobsTable.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  const statements = rubric ? await statementsOf(database, rubric.id) : [];
  const [golden, latest, submitted, stability] = rubric
    ? await Promise.all([
        goldenState(database, rubric.id, statements),
        latestCalibration(database, rubric.id),
        submittedCalibration(database, rubric.id),
        stabilityView(database, rubric.id, { statements }),
      ])
    : [null, null, null, null];
  const handoff = await handoffView(database, submission, { rubric, statements, golden, calibration: submitted, stability });

  const ids = new Set<string>();
  for (const v of [submission.rubricAssigneeId, submission.reviewerId, latest?.reviewerId, ...events.map((e) => e.actorId), ...feedback.map((f) => f.reviewerId)]) if (v) ids.add(v);
  const people: SubmissionView['people'] = {};
  if (ids.size) {
    for (const p of await database.select().from(profiles).where(inArray(profiles.id, [...ids]))) people[p.id] = { name: p.displayName ?? p.email, email: p.email };
  }

  const lens = taskLens(actor, submission);
  const caps = await capsFor(actor);
  const reviewVisible = lens === 'controller' || lens === 'reviewer';
  const hideReviewAnswers = !reviewVisible;

  return {
    submission: {
      id: submission.id,
      catalogSubmissionId: submission.catalogSubmissionId,
      projectId: submission.projectId,
      statusId: submission.statusId,
      title: submission.title,
      stage: submission.stage,
      landedAt: submission.landedAt,
      lastSeenAt: submission.lastSeenAt,
      upstreamChangedAt: submission.upstreamChangedAt,
      lastClaimedAt: submission.lastClaimedAt,
      rubricAssigneeId: submission.rubricAssigneeId,
      rubricClaimedAt: submission.rubricClaimedAt,
      reviewerId: submission.reviewerId,
      reviewClaimedAt: submission.reviewClaimedAt,
      reviewStatus: submission.reviewStatus,
      handoffStatus: submission.handoffStatus,
      pushedAt: submission.pushedAt,
      revision: submission.revision,
    },
    people,
    brief: {
      projectName: source?.projectName ?? '',
      statusName: source?.statusName ?? null,
      author: source?.author ?? null,
      heroDeliverable: heroDeliverableFromSource(submission.source),
      fields: source?.fields ?? [],
      hasAcceptanceCriteria: source ? acceptanceCriteriaText(source.values) !== '' : false,
      inputFiles: (source?.inputFiles ?? []).map(stripUrls),
      goldenFiles: lens === 'reviewer' ? [] : (source?.goldenFiles ?? []).map(stripUrls),
    },
    rubric: rubric
      ? {
          id: rubric.id,
          version: rubric.version,
          revision: rubric.revision,
          seeds: lens === 'reviewer' ? [] : rubric.seeds,
          generation: lens === 'reviewer' ? {} : rubric.generation,
          statements,
          quotas: familyQuotas(RUBRIC_TARGET),
          target: RUBRIC_TARGET,
        }
      : null,
    golden: lens === 'reviewer' || !golden ? null : { verdicts: golden.verdicts, evidence: golden.evidence, errors: golden.errors, sources: golden.sources, audit: golden.audit, gate: golden.gate },
    aiOutputs,
    review: {
      latest:
        latest && !hideReviewAnswers
          ? { id: latest.id, answers: latest.answers, evidence: latest.evidence, scorePercent: latest.scorePercent, submitted: latest.submitted, reviewerId: latest.reviewerId, createdAt: latest.createdAt }
          : null,
      submittedPercent: submitted?.scorePercent ?? null,
      feedback: feedback.map((f) => ({ decision: f.decision, feedback: f.feedback, reviewerId: f.reviewerId, createdAt: f.createdAt })),
    },
    stability:
      lens === 'reviewer' || !stability
        ? null
        : {
            groupId: stability.groupId,
            passes: stability.passes.map((p) => ({ passIndex: p.passIndex, answers: p.answers, evidence: p.evidence, errors: p.errors, scorePercent: p.scorePercent, model: p.model, createdAt: p.createdAt, basis: { statementsAt: (p.basis as { statementsAt?: string } | null)?.statementsAt } })),
            gate: stability.gate,
            acceptedAt: stability.accepted?.createdAt ?? null,
            calibrationGateActive: stability.calibrationGateActive,
            flipNotes: stability.flipNotes.map((n) => ({ statementId: n.statementId, action: n.action, note: n.note })),
          },
    handoff: { gates: handoff.gates, goldenPercent: handoff.goldenPercent, calibrationPercent: handoff.calibrationPercent, stabilityScores: handoff.stabilityScores },
    jobs: (lens === 'reviewer' ? [] : lens === 'rubric' ? jobs.filter((j) => j.status === 'queued' || j.status === 'running') : jobs).map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      progress: j.progress,
      error: j.error,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      attempts: j.attempts,
    })),
    helper:
      lens === 'reviewer' || !helperJob
        ? null
        : {
            id: helperJob.id,
            status: helperJob.status,
            progress: helperJob.progress,
            error: helperJob.error,
            result: tightenReportOf(helperJob.result),
          },
    events: lens === 'controller' ? events.filter(isUserInteraction).map((e) => ({ id: e.id, actorId: e.actorId, action: e.action, detail: e.detail, createdAt: e.createdAt })) : [],
    catalogReturnNote: parseCatalogReturn(submission.catalogReturn)?.note ?? null,
    can: {
      lens,
      editRubric: holdsRubricSeat(actor, submission) && submission.stage === 'rubric',
      holdsRubricSeat: holdsRubricSeat(actor, submission),
      runStability: canRunStability(actor, submission),
      runGolden: holdsRubricSeat(actor, submission),
      review:
        holdsReviewSeat(actor, submission) &&
        submission.stage === 'review' &&
        (isController(actor) || !isOwnRubricSeat(actor, submission)),
      control: isController(actor),
      claimRubric: submission.rubricAssigneeId === null && (isController(actor) || caps.canCreateRubrics),
      claimReview: claimableSeat(actor, submission, caps) === 'review',
      push:
        (holdsRubricSeat(actor, submission) || isController(actor)) &&
        canSubmitToDataPlatform({
          golden: handoff.gates.golden,
          calibration: handoff.gates.calibration,
          stability: stability?.gate?.ok === true,
          handoffStatus: submission.handoffStatus,
          pushedAt: submission.pushedAt,
        }),
      seeHistory: lens === 'controller',
      seeJobsLog: lens === 'controller',
      seeRunProgress: lens === 'rubric' || lens === 'controller',
      seeReviewPanel: lens === 'controller' || lens === 'reviewer',
      seeRubricEditor: lens === 'controller' || lens === 'rubric',
      seeGoldenFiles: lens !== 'reviewer',
      seeStability: lens !== 'reviewer',
      seeHandoff: lens === 'controller',
      seeAiUpload: lens !== 'reviewer',
      changeAiOutputs: canChangeAiOutputs(actor, submission),
      seeScoreGolden: lens !== 'reviewer',
      seeScoreStability: lens !== 'reviewer',
    },
  };
}

/**
 * Cheap watch for the task page: stage, seats, revision, job statuses.
 * Same visibility and job filtering as the full view so a no-op pulse
 * never triggers a reload.
 */
export async function submissionPulse(actor: Actor, id: string): Promise<StatusPulse> {
  const database = db();
  const submission = await getVisibleSubmission(database, actor, id);
  const lens = taskLens(actor, submission);
  const raw =
    lens === 'reviewer'
      ? []
      : await database
          .select({ id: jobsTable.id, status: jobsTable.status, progress: jobsTable.progress })
          .from(jobsTable)
          .where(eq(jobsTable.submissionId, id))
          .orderBy(desc(jobsTable.createdAt))
          .limit(12);
  const visible = lens === 'rubric' ? raw.filter((job) => job.status === 'queued' || job.status === 'running') : raw;
  return {
    stage: submission.stage,
    reviewStatus: submission.reviewStatus,
    handoffStatus: submission.handoffStatus,
    rubricAssigneeId: submission.rubricAssigneeId,
    reviewerId: submission.reviewerId,
    revision: submission.revision,
    jobs: visible.map((job) => ({ id: job.id, status: job.status, progressKey: progressKeyOf(job.progress) })),
  };
}

/** Presigned URLs stay on the server; the browser gets names only. */
function stripUrls(file: CatalogFile): CatalogFile {
  return { ...file, downloadUrl: null, previewUrl: null, thumbnailUrl: null };
}
