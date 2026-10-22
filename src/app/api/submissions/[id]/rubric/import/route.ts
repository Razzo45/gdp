import { z } from 'zod';
import { RUBRIC_TAGS } from '@/domain/rubric';
import { route } from '@/lib/api';
import { replaceRubricFromPaste } from '@/lib/services/rubric';

/** Paste a full external rubric. Replaces the current version. Must seat 50 at 5 / 15 / 30, at most 2 seats off. */
const Body = z.object({
  revision: z.number().int().nonnegative(),
  rows: z
    .array(z.object({ tag: z.enum(RUBRIC_TAGS), statement: z.string().trim().min(8).max(600) }))
    .min(1)
    .max(200),
});

export const POST = route({ body: Body }, async ({ actor, body, params }) => replaceRubricFromPaste(actor, params['id']!, body));
