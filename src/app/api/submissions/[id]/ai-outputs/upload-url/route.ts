import { z } from 'zod';
import { route } from '@/lib/api';
import { beginAiOutput } from '@/lib/services/files';

/** Signed PUT target. The file bytes never enter this process. */
export const POST = route({ body: z.object({ name: z.string().min(1).max(240), mime: z.string().max(200).optional(), size: z.number().int().positive() }) }, async ({ actor, params, body }) => {
  return beginAiOutput(actor, params['id']!, { name: body.name, mime: body.mime ?? '', size: body.size });
});
