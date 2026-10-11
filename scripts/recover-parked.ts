import './railway-target';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  calibrations,
  goldenRatings,
  rubrics,
  stabilityAcceptances,
  submissionEvents,
  submissions,
  type ReviewStatus,
} from '@/db/schema';
import { recoverParkedPipeline } from '@/domain/catchup';
import { workStateOf } from '@/domain/workState';
import { recordEvent } from '@/lib/services/submissions';

/**
 * Unparks rows catchup marked Other. Restores stage from Railway events,
 * live GDP review/handoff, and eval rows. Never writes to live Catalog.
 *
 *   npx tsx --conditions=react-server scripts/recover-parked.ts
 *   npx tsx --conditions=react-server scripts/recover-parked.ts --apply
 */
const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

function load(name: string): Record<string, unknown>[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function asReview(value: string): ReviewStatus | null {
  if (value === 'pending' || value === 'approved' || value === 'changes_requested') return value;
  return null;
}

function latestReview(internalId: string): ReviewStatus | null {
  const rows = [...load('public.wirestock_reviews_v1.json'), ...load('public.wirestock_submission_reviews.json')]
    .filter(isRecord)
    .filter((row) => str(row, 'submission_id') === internalId)
    .sort((a, b) => str(b, 'updated_at', 'decision_at', 'created_at').localeCompare(str(a, 'updated_at', 'decision_at', 'created_at')));
  return asReview(str(rows[0] ?? {}, 'status'));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const database = db();
  const parked = await database.select().from(submissions).where(eq(submissions.stage, 'parked'));
  if (parked.length === 0) {
    console.log('No parked tasks.');
    process.exit(0);
  }

  const internalOf = new Map(load('public.wirestock_submissions.json').filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'id')]));
  const handoffs = new Map(load('public.wirestock_submission_handoffs.json').filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'status')]));
  const states = new Map(load('public.wirestock_submission_states.json').filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'state')]));
  const liveCals = new Set(
    load('public.wirestock_rubric_answers.json')
      .filter(isRecord)
      .filter((row) => row['calibrated_at'] || Object.keys(isRecord(row['calibration_answers']) ? row['calibration_answers'] : {}).length)
      .map((row) => str(row, 'run_id')),
  );
  const runs = load('public.wirestock_rubric_runs.json').filter(isRecord);
  const calibratedInternal = new Set(
    runs.filter((row) => liveCals.has(str(row, 'id'))).map((row) => str(row, 'submission_id')),
  );
  const acceptedStab = new Set(
    load('public.local_stability_results.json')
      .filter(isRecord)
      .filter((row) => row['accepted_at'])
      .map((row) => str(row, 'submission_id')),
  );

  const events = await database
    .select({
      submissionId: submissionEvents.submissionId,
      action: submissionEvents.action,
      createdAt: submissionEvents.createdAt,
    })
    .from(submissionEvents)
    .where(inArray(submissionEvents.submissionId, parked.map((row) => row.id)));
  const byTask = new Map<string, { action: string; createdAt: string }[]>();
  for (const event of events) {
    const list = byTask.get(event.submissionId) ?? [];
    list.push({ action: event.action, createdAt: event.createdAt });
    byTask.set(event.submissionId, list);
  }

  const current = await database.select({ id: rubrics.id, submissionId: rubrics.submissionId }).from(rubrics).where(eq(rubrics.isCurrent, true));
  const rubricOf = new Map(current.map((row) => [row.submissionId, row.id]));
  const rubricIds = current.map((row) => row.id);
  const accepted = new Set(
    rubricIds.length
      ? (await database.select({ rubricId: stabilityAcceptances.rubricId }).from(stabilityAcceptances).where(inArray(stabilityAcceptances.rubricId, rubricIds))).map((row) => row.rubricId)
      : [],
  );
  const submittedCalRows = rubricIds.length
    ? await database.select({ rubricId: calibrations.rubricId, submitted: calibrations.submitted }).from(calibrations).where(inArray(calibrations.rubricId, rubricIds))
    : [];
  const calSubmitted = new Set(submittedCalRows.filter((row) => row.submitted).map((row) => row.rubricId));
  const goldenRubrics = new Set(
    rubricIds.length
      ? (await database.select({ rubricId: goldenRatings.rubricId }).from(goldenRatings).where(inArray(goldenRatings.rubricId, rubricIds))).map((row) => row.rubricId)
      : [],
  );

  const counts: Record<string, number> = {};
  let changed = 0;
  for (const row of parked) {
    const internal = internalOf.get(row.catalogSubmissionId) ?? '';
    const rubricId = rubricOf.get(row.id);
    const next = recoverParkedPipeline({
      events: byTask.get(row.id) ?? [],
      pushedAt: row.pushedAt,
      liveReviewStatus: (internal ? latestReview(internal) : null) ?? row.reviewStatus,
      liveHandoffStatus: (internal ? handoffs.get(internal) : null) ?? row.handoffStatus,
      liveGdpState: internal ? states.get(internal) ?? null : null,
      hasStabilityAcceptance: Boolean((rubricId && accepted.has(rubricId)) || (internal && acceptedStab.has(internal)) || acceptedStab.has(row.catalogSubmissionId)),
      hasSubmittedCalibration: Boolean((rubricId && calSubmitted.has(rubricId)) || (internal && calibratedInternal.has(internal))),
    });
    const label = workStateOf({ ...row, ...next });
    counts[label] = (counts[label] ?? 0) + 1;
    const same = row.stage === next.stage && row.reviewStatus === next.reviewStatus && row.handoffStatus === next.handoffStatus;
    if (same) continue;
    changed += 1;
    console.log(
      `${row.catalogSubmissionId.slice(0, 8)} ${(row.title.slice(0, 48) || '(no title)')}  other → ${label}  (${next.stage}${next.reviewStatus ? `/${next.reviewStatus}` : ''}${next.handoffStatus ? `/${next.handoffStatus}` : ''})${rubricId && goldenRubrics.has(rubricId) ? ' [golden]' : ''}`,
    );
    if (!apply) continue;
    await database
      .update(submissions)
      .set({ stage: next.stage, reviewStatus: next.reviewStatus, handoffStatus: next.handoffStatus })
      .where(eq(submissions.id, row.id));
    await recordEvent(database, row.id, null, 'pipeline_recovered', { from: 'parked', to: next });
  }

  console.log(`${apply ? 'Wrote' : 'Would update'} ${changed} / ${parked.length} parked tasks`);
  console.log('Board', counts);
  if (!apply) console.log('Re-run with --apply to write Railway only.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
