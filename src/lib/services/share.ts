import 'server-only';

import { db } from '@/db/client';
import { deliveryId, seatsInDisplayOrder } from '@/domain/rubric';
import type { SharePack } from '@/domain/sharePack';
import { viewTaskTokenMatches } from '@/domain/viewTask';
import { env } from '@/lib/env';
import { taskPerformanceSummaries } from '@/lib/catalog/export';
import { listAiOutputs } from './files';
import { notFound } from './errors';
import { handoffView } from './handoff';
import { currentRubric, statementsOf } from './rubric';
import { getSubmission, readSource } from './submissions';

export type { SharePack } from '@/domain/sharePack';

export function assertShareToken(submissionId: string, token: string | null | undefined): void {
  const secret = env().AUTH_LOCAL_SECRET;
  if (!token || !viewTaskTokenMatches(secret, submissionId, token)) throw notFound('The shared task');
}

export async function sharePack(submissionId: string, token: string | null | undefined): Promise<SharePack> {
  assertShareToken(submissionId, token);
  const database = db();
  const submission = await getSubmission(database, submissionId);
  const source = readSource(submission);
  const rubric = await currentRubric(database, submissionId);
  const statements = rubric ? await statementsOf(database, rubric.id) : [];
  const view = await handoffView(database, submission, { rubric, statements });
  const ai = await listAiOutputs(database, submissionId);
  const fields = (source?.fields ?? []).filter((f) => f.key !== 'inputFiles' && f.key !== 'prompt');
  const task =
    source?.fields.find((f) => /^(prompt|task|instruction|description)$/i.test(f.key))?.text?.trim() ||
    source?.title?.trim() ||
    submission.title;
  return {
    submissionId: submission.id,
    title: source?.title || submission.title || 'Task',
    task,
    fields,
    inputs: (source?.inputFiles ?? []).map((f) => ({ id: f.id, name: f.name, mime: f.mime, kind: 'input' as const })),
    golden: (source?.goldenFiles ?? []).map((f) => ({ id: f.id, name: f.name, mime: f.mime, kind: 'golden' as const })),
    aiOutputs: ai.map((f) => ({ id: f.id, name: f.name, mime: f.mime, kind: 'ai' as const })),
    performance: taskPerformanceSummaries({
      goldenPercent: view.goldenPercent,
      calibrationPercent: view.calibrationPercent,
      stabilityScores: view.stabilityScores,
    }),
    rubric: seatsInDisplayOrder(statements).map((s, index) => ({
      id: deliveryId(index),
      statement: s.statement,
      tag: s.tag,
    })),
  };
}
