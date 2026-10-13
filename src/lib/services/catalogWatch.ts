import 'server-only';

import { db } from '@/db/client';
import { submissions, watchedProjects } from '@/db/schema';
import { catalogIdsToPull, inboundWatchStatusIds, returnWatchStatusIds } from '@/domain/catalogInbound';
import { catalogConfigured, listAllProjectSubmissions } from '@/lib/catalog/client';
import { syncSubmission } from './submissions';

/**
 * Pull new Catalog rows only on inbound-ready statuses (K / E / work).
 * Known tasks are also refreshed when Catalog sends them back. Webhooks
 * should do this live; this sweep covers deliveries we never got.
 */

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export async function reconcileWatchedCatalog(): Promise<{ pulled: number; failed: number }> {
  if (!catalogConfigured()) return { pulled: 0, failed: 0 };
  const watches = await db().select().from(watchedProjects);
  const known = new Set((await db().select({ id: submissions.catalogSubmissionId }).from(submissions)).map((row) => row.id));
  let pulled = 0;
  let failed = 0;
  for (const watch of watches) {
    const listed = await listAllProjectSubmissions(watch.projectId);
    if (!listed.ok) {
      failed += 1;
      continue;
    }
    const workflow = object(object(watch.project)['workflow']);
    const watchInput = {
      workStatusId: watch.workStatusId,
      handoffStatusId: watch.handoffStatusId,
      inboundStatusIds: watch.statusIds,
      statuses: workflow['statuses'],
      transitions: workflow['transitions'],
    };
    const ids = catalogIdsToPull(listed.submissions, inboundWatchStatusIds(watchInput), known, Date.now(), 24 * 60 * 60 * 1000, returnWatchStatusIds(watchInput));
    for (const id of ids) {
      try {
        await syncSubmission(id, null);
        known.add(id);
        pulled += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { pulled, failed };
}
