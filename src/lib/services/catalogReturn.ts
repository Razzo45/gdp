import 'server-only';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissions, type Submission } from '@/db/schema';
import { parseCatalogReturn, type PendingCatalogReturn } from '@/domain/catalogReturn';
import { canOversee, isController, type Actor } from '@/lib/auth/permissions';
import { conflict, forbidden } from './errors';
import { scheduleWorkStatusSheet } from '@/lib/sheets/workStatus';
import { heroDeliverableFromSource } from '@/lib/catalog/read';
import { getSubmission, recordEvent } from './submissions';

export type { PendingCatalogReturn };

export async function acceptCatalogReturn(actor: Actor, submissionId: string): Promise<Submission> {
  if (!isController(actor)) throw forbidden('Only PMs and admins can accept a Catalog return.');
  const result = await db().transaction(async (tx) => {
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
    return { previous: submission, next: updated! };
  });
  scheduleWorkStatusSheet(result.previous, result.next);
  return result.next;
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
  if (!canOversee(actor)) throw forbidden('Only PMs, admins, and observers can see Catalog returns.');
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
        heroDeliverable: heroDeliverableFromSource(row.source),
        stage: row.stage,
        statusId: row.statusId,
        catalogReturn,
      },
    ];
  });
}
