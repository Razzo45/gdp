import { z } from 'zod';
import { route } from '@/lib/api';
import { noteFlip } from '@/lib/services/stability';

const Body = z.object({
  groupId: z.string().uuid(),
  statementId: z.string().uuid(),
  action: z.enum(['acknowledged', 'rewrite_requested']),
  note: z.string().trim().min(5).max(2000),
});

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  await noteFlip(actor, params['id']!, body);
  return { ok: true };
});
