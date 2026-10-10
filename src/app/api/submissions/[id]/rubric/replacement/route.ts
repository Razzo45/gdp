import { z } from 'zod';
import { db } from '@/db/client';
import { route } from '@/lib/api';
import { addFromBank, keepReplacement, replacementCandidates } from '@/lib/services/rubric';
import { getVisibleSubmission } from '@/lib/services/submissions';

/**
 * Bank browser + "Find alternatives": browse unused factory-bank claims,
 * then keep one in a seat or add it as a new row. Keeping swaps wording
 * in place (same seat id) so position and file scope survive; the Golden
 * grade goes stale by content hash.
 */
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('propose'), statementId: z.string().uuid() }),
  z.object({ action: z.literal('keep'), statementId: z.string().uuid(), claimKey: z.string().min(1).max(200), revision: z.number().int().nonnegative() }),
  z.object({ action: z.literal('add'), claimKey: z.string().min(1).max(200), revision: z.number().int().nonnegative() }),
]);

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const id = params['id']!;
  if (body.action === 'propose') {
    await getVisibleSubmission(db(), actor, id);
    const { candidates } = await replacementCandidates(db(), id, body.statementId);
    return { candidates };
  }
  if (body.action === 'add') return addFromBank(actor, id, body);
  return keepReplacement(actor, id, body);
});
