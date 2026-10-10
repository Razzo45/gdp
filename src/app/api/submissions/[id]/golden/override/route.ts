import { z } from 'zod';
import { route } from '@/lib/api';
import { overrideGolden } from '@/lib/services/rubric';

const Body = z
  .object({
    statementId: z.string().uuid(),
    verdict: z.boolean(),
    evidence: z.string().trim().min(5).max(2000).optional(),
    reason: z.string().trim().min(5).max(2000).optional(),
  })
  .refine((body) => (body.evidence ?? body.reason ?? '').length >= 5, { message: 'An observation of at least 5 characters is required.' });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  await overrideGolden(actor, params['id']!, body.statementId, body.verdict, body.evidence ?? body.reason!);
  return { ok: true };
});
