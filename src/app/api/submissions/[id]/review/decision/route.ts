import { z } from 'zod';
import { route } from '@/lib/api';
import { decideReview } from '@/lib/services/review';

const Body = z.object({ decision: z.enum(['approved', 'changes_requested']), feedback: z.string().max(4000).default('') });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  await decideReview(actor, params['id']!, body.decision, body.feedback);
  return { ok: true };
});
