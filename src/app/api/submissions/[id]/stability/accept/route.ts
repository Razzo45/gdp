import { z } from 'zod';
import { route } from '@/lib/api';
import { acceptStability } from '@/lib/services/stability';

export const POST = route({ body: z.object({ groupId: z.string().uuid() }) }, async ({ actor, body, params }) => {
  await acceptStability(actor, params['id']!, body.groupId);
  return { ok: true };
});
