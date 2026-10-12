import { z } from 'zod';
import { route } from '@/lib/api';
import { acceptCatalogReturn, dismissCatalogReturn } from '@/lib/services/catalogReturn';

const Body = z.object({ action: z.enum(['accept', 'dismiss']) });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const submission = body.action === 'accept' ? await acceptCatalogReturn(actor, params['id']!) : await dismissCatalogReturn(actor, params['id']!);
  return { id: submission.id, stage: submission.stage, handoffStatus: submission.handoffStatus, pushedAt: submission.pushedAt };
});
