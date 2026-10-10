import { db } from '@/db/client';
import { route } from '@/lib/api';
import { getVisibleSubmission, syncSubmission } from '@/lib/services/submissions';

export const POST = route({}, async ({ actor, params }) => {
  const current = await getVisibleSubmission(db(), actor, params['id']!);
  const refreshed = await syncSubmission(current.catalogSubmissionId, actor.id);
  return { id: refreshed.id, lastSeenAt: refreshed.lastSeenAt, upstreamChangedAt: refreshed.upstreamChangedAt };
});
