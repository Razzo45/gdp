import { z } from 'zod';
import { route } from '@/lib/api';
import { openReturnedWork } from '@/lib/services/catalogReturn';

const Body = z.object({ target: z.enum(['rubric', 'stability']) });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const submission = await openReturnedWork(actor, params['id']!, body.target);
  return { id: submission.id, stage: submission.stage, handoffStatus: submission.handoffStatus };
});
