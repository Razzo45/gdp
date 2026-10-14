import 'server-only';

import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { calibrations, goldenRatings, jobs, reviewFeedback, rubrics, stabilityAcceptances, stabilityFlipNotes, stabilityPasses } from '@/db/schema';
import type { DbOrTx } from '@/db/types';

/** Latest plus two previous ratings per statement and source. Older rows are deleted. */
export const KEEP = 3;

export async function pruneRubricVersions(database: DbOrTx, submissionId: string): Promise<number> {
  const rows = await database.select({ id: rubrics.id }).from(rubrics).where(eq(rubrics.submissionId, submissionId)).orderBy(desc(rubrics.version));
  const drop = rows.slice(KEEP).map((r) => r.id);
  if (drop.length) await database.delete(rubrics).where(inArray(rubrics.id, drop));
  return drop.length;
}

export async function pruneGoldenRatings(database: DbOrTx, rubricId: string): Promise<number> {
  const rows = await database.select().from(goldenRatings).where(eq(goldenRatings.rubricId, rubricId)).orderBy(desc(goldenRatings.createdAt));
  const keep = new Set<string>();
  const seenByStatement = new Map<string, { usable: number; failed: number; human: number }>();
  for (const row of rows) {
    const seen = seenByStatement.get(row.statementId) ?? { usable: 0, failed: 0, human: 0 };
    if (row.source === 'human') {
      if (seen.human < KEEP) keep.add(row.id);
      seen.human += 1;
    } else if (row.error || (row.verdict !== true && row.verdict !== false)) {
      if (seen.failed < 1) keep.add(row.id);
      seen.failed += 1;
    } else {
      if (seen.usable < KEEP) keep.add(row.id);
      seen.usable += 1;
    }
    seenByStatement.set(row.statementId, seen);
  }
  const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) await database.delete(goldenRatings).where(inArray(goldenRatings.id, drop));
  return drop.length;
}

export async function pruneCalibrations(database: DbOrTx, rubricId: string): Promise<number> {
  const rows = await database.select({ id: calibrations.id }).from(calibrations).where(eq(calibrations.rubricId, rubricId)).orderBy(desc(calibrations.createdAt));
  const drop = rows.slice(KEEP).map((r) => r.id);
  if (drop.length) await database.delete(calibrations).where(inArray(calibrations.id, drop));
  return drop.length;
}

export async function pruneStabilityGroups(database: DbOrTx, rubricId: string): Promise<number> {
  const passes = await database.select({ groupId: stabilityPasses.groupId, createdAt: stabilityPasses.createdAt }).from(stabilityPasses).where(eq(stabilityPasses.rubricId, rubricId)).orderBy(desc(stabilityPasses.createdAt));
  const groups: string[] = [];
  for (const row of passes) if (!groups.includes(row.groupId)) groups.push(row.groupId);
  const drop = groups.slice(KEEP);
  if (drop.length === 0) return 0;
  await database.delete(stabilityFlipNotes).where(inArray(stabilityFlipNotes.groupId, drop));
  await database.delete(stabilityAcceptances).where(inArray(stabilityAcceptances.groupId, drop));
  await database.delete(stabilityPasses).where(inArray(stabilityPasses.groupId, drop));
  return drop.length;
}

export async function pruneReviewFeedback(database: DbOrTx, submissionId: string): Promise<number> {
  const rows = await database.select({ id: reviewFeedback.id }).from(reviewFeedback).where(eq(reviewFeedback.submissionId, submissionId)).orderBy(desc(reviewFeedback.createdAt));
  const drop = rows.slice(KEEP).map((r) => r.id);
  if (drop.length) await database.delete(reviewFeedback).where(inArray(reviewFeedback.id, drop));
  return drop.length;
}

export async function pruneFinishedJobs(database: DbOrTx, submissionId: string, kind: 'rubric_generate' | 'golden_autorate' | 'stability_run' | 'rubric_helper'): Promise<number> {
  const rows = await database
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.submissionId, submissionId), eq(jobs.kind, kind)))
    .orderBy(desc(jobs.finishedAt), desc(jobs.createdAt));
  const finished = rows.filter((r) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled');
  const drop = finished.slice(KEEP).map((r) => r.id);
  if (drop.length) await database.delete(jobs).where(and(inArray(jobs.id, drop), notInArray(jobs.status, ['queued', 'running'])));
  return drop.length;
}
