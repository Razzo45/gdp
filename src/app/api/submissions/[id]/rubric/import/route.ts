import { z } from 'zod';
import { route } from '@/lib/api';
import { importStatements } from '@/lib/services/rubric';

/** Paste statements, one per line (optional `Tag | statement`). Questions become affirmatives. */
const Body = z.object({ text: z.string().min(1).max(200_000), revision: z.number().int().nonnegative() });

export const POST = route({ body: Body }, async ({ actor, body, params }) => importStatements(actor, params['id']!, body));
