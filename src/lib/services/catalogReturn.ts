import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissions, type Submission } from '@/db/schema';
import { parseCatalogReturn, type PendingCatalogReturn } from '@/domain/catalogReturn';
import { isController, type Actor } from '@/lib/auth/permissions';
import { conflict, forbidden } from './errors';
import { getSubmission, recordEvent } from './submissions';

export type { PendingCatalogReturn };

export async function acceptCatalogReturn(actor: Actor, submissionId: string): Promise<Submission> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can accept a Catalog return.');
  return db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    const pending = parseCatalogReturn(submission.catalogReturn);
    if (pending?.outcome !== 'pending') throw conflict('There is no Catalog return waiting on this task.');
    const [updated] = await tx
      .update(submissions)
      .set({
        stage: 'rubric',
        handoffStatus: 'bounced',
        pushedAt: null,
        catalogReturn: null,
      })
      .where(eq(submissions.id, submissionId))
      .returning();
    await recordEvent(tx, submissionId, actor.id, 'catalog_returned', {
      ...pending,
      previousPushedAt: submission.pushedAt,
      previousReceipt: submission.pushReceipt,
      rubricAssigneeId: submission.rubricAssigneeId,
      reviewerId: submission.reviewerId,
    });
    return updated!;
  });
}

export async function dismissCatalogReturn(actor: Actor, submissionId: string): Promise<Submission> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can dismiss a Catalog return.');
  return db().transaction(async (tx) => {
    const submission = await getSubmission(tx, submissionId);
    const pending = parseCatalogReturn(submission.catalogReturn);
    if (pending?.outcome !== 'pending') throw conflict('There is no Catalog return waiting on this task.');
    const catalogReturn = { ...pending, outcome: 'dismissed' as const };
    const [updated] = await tx.update(submissions).set({ catalogReturn }).where(eq(submissions.id, submissionId)).returning();
    await recordEvent(tx, submissionId, actor.id, 'catalog_return_dismissed', pending);
    return updated!;
  });
}

export async function listPendingCatalogReturns(actor: Actor): Promise<PendingCatalogReturn[]> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can see Catalog returns.');
  const rows = await db()
    .select()
    .from(submissions)
    .where(sql`${submissions.catalogReturn}->>'outcome' = 'pending'`)
    .orderBy(sql`${submissions.upstreamChangedAt} desc nulls last`);
  return rows.flatMap((row) => {
    const catalogReturn = parseCatalogReturn(row.catalogReturn);
    if (catalogReturn?.outcome !== 'pending') return [];
    return [
      {
        id: row.id,
        catalogSubmissionId: row.catalogSubmissionId,
        title: row.title,
        stage: row.stage,
        statusId: row.statusId,
        catalogReturn,
      },
    ];
  });
}
