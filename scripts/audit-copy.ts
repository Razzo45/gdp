import './env';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  aiOutputFiles,
  calibrations,
  goldenRatings,
  profiles,
  reviewFeedback,
  rubrics,
  stabilityAcceptances,
  stabilityPasses,
  submissions,
  userRoles,
  watchedProjects,
} from '@/db/schema';
import { classifyCatalogListState } from '@/domain/catalogListState';
import { readCatalogSubmission } from '@/lib/catalog/read';

const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

function load(name: string): Record<string, unknown>[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(parsed) ? parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseMarker(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'object' && raw && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function main() {
  const database = db();
  const neonSubs = await database.select().from(submissions);
  const neonProfiles = await database.select().from(profiles);
  const neonRoles = await database.select().from(userRoles);
  const neonWatches = await database.select().from(watchedProjects);
  const neonRubrics = await database.select().from(rubrics);
  const neonGold = await database.select({ rubricId: goldenRatings.rubricId, source: goldenRatings.source }).from(goldenRatings);
  const neonCals = await database.select().from(calibrations);
  const neonPasses = await database.select({ rubricId: stabilityPasses.rubricId, groupId: stabilityPasses.groupId, answers: stabilityPasses.answers, scorePercent: stabilityPasses.scorePercent }).from(stabilityPasses);
  const neonAcc = await database.select().from(stabilityAcceptances);
  const neonReviews = await database.select().from(reviewFeedback);
  const neonFiles = await database.select({ submissionId: aiOutputFiles.submissionId, removedAt: aiOutputFiles.removedAt }).from(aiOutputFiles);

  const liveSubs = load('public.wirestock_submissions.json');
  const liveProfiles = load('public.profiles.json');
  const liveRuns = load('public.wirestock_rubric_runs.json');
  const liveAnswers = load('public.wirestock_rubric_answers.json');
  const liveQuality = load('public.wirestock_quality_results.json');
  const liveCals = load('public.wirestock_calibrations.json');
  const liveReviews = [...load('public.wirestock_reviews_v1.json'), ...load('public.wirestock_submission_reviews.json')];
  const liveFeedback = load('public.wirestock_review_feedback.json');
  const liveAssign = load('public.wirestock_submission_assignments.json');
  const liveHandoffs = load('public.wirestock_submission_handoffs.json');
  const liveStates = load('public.wirestock_submission_states.json');
  const liveStab = load('public.local_stability_results.json');
  const liveWatches = load('public.watched_projects.json');

  const runsByInternal = new Map<string, Record<string, unknown>[]>();
  for (const run of liveRuns) {
    const id = str(run, 'submission_id');
    const list = runsByInternal.get(id) ?? [];
    list.push(run);
    runsByInternal.set(id, list);
  }
  const answersByRun = new Map<string, Record<string, unknown>[]>();
  for (const row of liveAnswers) {
    const id = str(row, 'run_id');
    const list = answersByRun.get(id) ?? [];
    list.push(row);
    answersByRun.set(id, list);
  }

  const currentBySub = new Map(neonRubrics.filter((r) => r.isCurrent).map((r) => [r.submissionId, r]));
  const goldByRubric = new Map<string, { ai: number; human: number }>();
  for (const row of neonGold) {
    const cur = goldByRubric.get(row.rubricId) ?? { ai: 0, human: 0 };
    if (row.source === 'human') cur.human += 1;
    else cur.ai += 1;
    goldByRubric.set(row.rubricId, cur);
  }
  const calByRubric = new Map<string, typeof neonCals>();
  for (const row of neonCals) {
    const list = calByRubric.get(row.rubricId) ?? [];
    list.push(row);
    calByRubric.set(row.rubricId, list);
  }
  const passByRubric = new Map<string, typeof neonPasses>();
  for (const row of neonPasses) {
    const list = passByRubric.get(row.rubricId) ?? [];
    list.push(row);
    passByRubric.set(row.rubricId, list);
  }
  const accByRubric = new Set(neonAcc.map((row) => row.rubricId));
  const reviewBySub = new Map<string, typeof neonReviews>();
  for (const row of neonReviews) {
    const list = reviewBySub.get(row.submissionId) ?? [];
    list.push(row);
    reviewBySub.set(row.submissionId, list);
  }
  const filesBySub = new Map<string, number>();
  for (const row of neonFiles) {
    if (row.removedAt) continue;
    filesBySub.set(row.submissionId, (filesBySub.get(row.submissionId) ?? 0) + 1);
  }

  const watchById = new Map(neonWatches.map((w) => [w.projectId, w]));
  const neonByCatalog = new Map(neonSubs.map((s) => [s.catalogSubmissionId, s]));

  type Gap = {
    catalog: string;
    title: string;
    issues: string[];
    live: Record<string, unknown>;
    neon: Record<string, unknown>;
  };
  const gaps: Gap[] = [];
  let liveStabTasks = 0;
  let liveCalTasks = 0;
  let liveGoldTasks = 0;
  let liveReviewTasks = 0;
  let neonStabComplete = 0;
  let neonCalCount = 0;
  let neonGoldCount = 0;

  for (const live of liveSubs) {
    const internal = str(live, 'id');
    const catalog = str(live, 'submission_id');
    const read = readCatalogSubmission(live['submission'], live['project']);
    const title = (read?.title || catalog).slice(0, 72);
    const runs = runsByInternal.get(internal) ?? [];
    const runIds = runs.map((row) => str(row, 'id'));
    const answers = runIds.flatMap((id) => answersByRun.get(id) ?? []);
    const quality = liveQuality.filter((row) => str(row, 'submission_id') === internal && row['complete'] === true);
    const cals = liveCals.filter((row) => str(row, 'submission_id') === internal);
    const reviews = liveReviews.filter((row) => str(row, 'submission_id') === internal);
    const notes = liveFeedback.filter((row) => str(row, 'submission_id') === internal);
    const assigns = liveAssign.filter((row) => str(row, 'submission_id') === internal);
    const handoff = liveHandoffs.find((row) => str(row, 'submission_id') === internal);
    const state = liveStates.find((row) => str(row, 'submission_id') === internal);
    const localStab = liveStab.filter((row) => str(row, 'submission_id') === internal);

    let stabGroups = 0;
    let stabAccepted = false;
    let calAnswers = 0;
    let humanAnswers = 0;
    let goldAnswers = 0;
    for (const row of answers) {
      const qs = record(row['questions']);
      if (parseMarker(qs['__observability_stability_acceptance'])) stabAccepted = true;
      const list = Array.isArray(row['autorate_runs']) ? (row['autorate_runs'] as Record<string, unknown>[]) : [];
      const groups = new Set(
        list.filter((pass) => String(pass['source'] ?? '').startsWith('autorate_stability_')).map((pass) => str(pass, 'groupId', 'group_id')),
      );
      stabGroups += [...groups].filter(Boolean).length ? 1 : 0;
      if (Object.keys(record(row['calibration_answers'])).length) calAnswers += 1;
      const sources = record(row['sources']);
      if (Object.values(sources).some((v) => String(v) === 'human')) humanAnswers += 1;
      if (Object.keys(record(row['answers'])).length) goldAnswers += 1;
    }
    if (localStab.length) stabGroups += 1;
    if (cals.length || calAnswers) liveCalTasks += 1;
    if (quality.length || goldAnswers) liveGoldTasks += 1;
    if (stabGroups) liveStabTasks += 1;
    if (reviews.length || notes.length) liveReviewTasks += 1;

    const neon = neonByCatalog.get(catalog);
    const rubric = neon ? currentBySub.get(neon.id) : undefined;
    const gold = rubric ? goldByRubric.get(rubric.id) : undefined;
    const cal = rubric ? calByRubric.get(rubric.id) ?? [] : [];
    const passes = rubric ? passByRubric.get(rubric.id) ?? [] : [];
    const completePasses = passes.filter((p) => Object.keys(record(p.answers)).length >= 3).length;
    const hasAcc = rubric ? accByRubric.has(rubric.id) : false;
    if (cal.length) neonCalCount += 1;
    if (gold && gold.ai + gold.human > 0) neonGoldCount += 1;
    if (completePasses >= 3) neonStabComplete += 1;

    const issues: string[] = [];
    if (!neon) issues.push('missing-submission');
    if (runs.length && !rubric) issues.push('live-run-no-current-rubric');
    if ((quality.length || goldAnswers) && !(gold && gold.ai + gold.human > 0)) issues.push('live-golden-missing');
    if ((cals.length || calAnswers) && cal.length === 0) issues.push('live-calibration-missing');
    if (stabGroups && completePasses < 3) issues.push('live-stability-missing');
    if (stabAccepted && !hasAcc) issues.push('live-stability-acceptance-missing');
    if ((reviews.length || notes.length) && !(neon && (reviewBySub.get(neon.id)?.length ?? 0))) {
      const decided = [...reviews, ...notes].some((row) => /approved|changes_requested/.test(str(row, 'status')));
      if (decided) issues.push('live-review-missing');
    }
    if (assigns.length && neon && !neon.rubricAssigneeId && !neon.reviewerId) issues.push('live-assignment-missing');
    if (handoff && neon && !neon.handoffStatus) issues.push('live-handoff-missing');
    if (neon && neon.stage === 'review' && rubric && neon.reviewRubricId !== rubric.id) issues.push('review-rubric-id-unset');
    if (neon && (neon.stage === 'review' || neon.stage === 'stability' || neon.stage === 'handoff' || neon.stage === 'done') && (filesBySub.get(neon.id) ?? 0) === 0 && (quality.length || goldAnswers)) {
      issues.push('ai-output-missing');
    }

    if (neon) {
      const watch = watchById.get(neon.projectId);
      const project = record(record(neon.source)['project']);
      const workflow = record(project['workflow']);
      const lane = classifyCatalogListState({
        statusId: neon.statusId,
        workStatusId: watch?.workStatusId,
        handoffStatusId: watch?.handoffStatusId,
        statuses: workflow['statuses'] ?? [],
        transitions: workflow['transitions'] ?? [],
        reviewStatus: neon.reviewStatus,
        assigned: Boolean(neon.rubricAssigneeId || neon.reviewerId),
      });
      if (lane === 'review' && neon.stage !== 'review') issues.push(`stage-mismatch lane=${lane} neon=${neon.stage}`);
      if (lane === 'review_return' && neon.reviewStatus !== 'changes_requested') issues.push(`review-return-mismatch neonReview=${neon.reviewStatus}`);
      if (lane === 'submitted' && neon.stage !== 'done' && neon.handoffStatus !== 'client_visible') issues.push(`submitted-mismatch stage=${neon.stage} handoff=${neon.handoffStatus}`);
    }

    if (issues.length) {
      gaps.push({
        catalog: catalog.slice(0, 8),
        title,
        issues,
        live: {
          runs: runs.length,
          answers: answers.length,
          quality: quality.length,
          cals: cals.length,
          calAnswers,
          stabGroups,
          stabAccepted,
          reviews: reviews.length,
          notes: notes.length,
          assigns: assigns.length,
          state: state ? str(state, 'state') : null,
          handoff: handoff ? str(handoff, 'status') : null,
        },
        neon: {
          id: neon?.id ?? null,
          stage: neon?.stage ?? null,
          review: neon?.reviewStatus ?? null,
          handoff: neon?.handoffStatus ?? null,
          rubric: rubric?.id ?? null,
          gold,
          cal: cal.map((c) => c.scorePercent),
          stabPasses: completePasses,
          acc: hasAcc,
          reviews: neon ? reviewBySub.get(neon.id)?.length ?? 0 : 0,
          files: neon ? filesBySub.get(neon.id) ?? 0 : 0,
          assignee: neon?.rubricAssigneeId?.slice(0, 8) ?? null,
        },
      });
    }
  }

  const extraNeon = neonSubs.filter((s) => !liveSubs.some((live) => str(live, 'submission_id') === s.catalogSubmissionId));
  const liveEmails = new Set(liveProfiles.map((row) => str(row, 'email').toLowerCase()).filter(Boolean));
  const missingProfiles = liveProfiles.filter((row) => str(row, 'id') && !neonProfiles.some((p) => p.id === str(row, 'id')));

  console.log(JSON.stringify({
    snapshot: JSON.parse(readFileSync(path.join(SNAP, 'index.json'), 'utf8')).pulledAt,
    counts: {
      liveSubs: liveSubs.length,
      neonSubs: neonSubs.length,
      extraNeon: extraNeon.length,
      liveProfiles: liveProfiles.length,
      neonProfiles: neonProfiles.length,
      missingProfiles: missingProfiles.length,
      neonRoles: neonRoles.length,
      liveWatches: liveWatches.length,
      neonWatches: neonWatches.length,
      liveRuns: liveRuns.length,
      neonCurrentRubrics: neonRubrics.filter((r) => r.isCurrent).length,
      liveGoldTasks,
      neonGoldCount,
      liveCalTasks,
      neonCalCount,
      liveStabTasks,
      neonStabComplete,
      neonAcceptances: neonAcc.length,
      liveReviewTasks,
      neonReviews: neonReviews.length,
      neonFiles: neonFiles.filter((f) => !f.removedAt).length,
    },
    extraNeon: extraNeon.map((s) => ({ id: s.id, catalog: s.catalogSubmissionId, title: s.title.slice(0, 60), stage: s.stage })),
    missingProfiles: missingProfiles.map((row) => ({ id: str(row, 'id'), email: str(row, 'email') })),
    gapCounts: gaps.reduce<Record<string, number>>((acc, row) => {
      for (const issue of row.issues) acc[issue] = (acc[issue] ?? 0) + 1;
      return acc;
    }, {}),
    gaps,
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
