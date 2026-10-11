import { z } from 'zod';
import { route } from '@/lib/api';
import { finishAiOutput } from '@/lib/services/files';

/** Bind a finished object-store PUT to the task. */
export const POST = route(
  {
    body: z.object({
      path: z.string().min(1).max(500),
      name: z.string().min(1).max(240),
      mime: z.string().max(200).optional(),
      size: z.number().int().positive(),
      token: z.string().min(16).max(200),
      expires: z.number().int().positive(),
    }),
  },
  async ({ actor, params, body }) => {
    const file = await finishAiOutput(actor, params['id']!, {
      path: body.path,
      name: body.name,
      mime: body.mime ?? '',
      size: body.size,
      token: body.token,
      expires: body.expires,
    });
    return { file };
  },
);
