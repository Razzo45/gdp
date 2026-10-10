import { z } from 'zod';
import { route } from '@/lib/api';
import { reopenRubricFromStability } from '@/lib/services/stability';

export const POST = route({ body: z.object({ reason: z.string().trim().min(5).max(2000) }) }, async ({ actor, body, params }) => {
  await reopenRubricFromStability(actor, params['id']!, body.reason);
  return { ok: true };
});
