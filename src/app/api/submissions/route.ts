import { z } from 'zod';
import { STAGES } from '@/db/schema';
import { route } from '@/lib/api';
import { canCreateRubrics, isController } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/services/errors';
import { listSubmissions, syncSubmission } from '@/lib/services/submissions';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor, request }) => {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');
  return {
    submissions: await listSubmissions(actor, {
      stage: STAGES.includes(stage as (typeof STAGES)[number]) ? (stage as (typeof STAGES)[number]) : undefined,
      mine: url.searchParams.get('mine') === '1',
      projectId: url.searchParams.get('projectId') ?? undefined,
    }),
  };
});

/** Bring a Catalog submission onto the platform by id (or refresh it). */
export const POST = route({ body: z.object({ catalogSubmissionId: z.string().trim().min(1).max(200) }) }, async ({ actor, body }) => {
  if (!(isController(actor) || canCreateRubrics(actor))) throw forbidden('You cannot import tasks.');
  const submission = await syncSubmission(body.catalogSubmissionId, actor.id);
  return { id: submission.id };
});
