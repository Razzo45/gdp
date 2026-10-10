import { z } from 'zod';
import { route } from '@/lib/api';
import { assignSeat, claimSeat, releaseSeat } from '@/lib/services/submissions';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), seat: z.enum(['rubric', 'review']) }),
  z.object({ action: z.literal('release'), seat: z.enum(['rubric', 'review']) }),
  z.object({ action: z.literal('assign'), seat: z.enum(['rubric', 'review']), userId: z.string().uuid().nullable() }),
]);

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const id = params['id']!;
  const submission =
    body.action === 'claim' ? await claimSeat(actor, id, body.seat) : body.action === 'release' ? await releaseSeat(actor, id, body.seat) : await assignSeat(actor, id, body.seat, body.userId);
  return { rubricAssigneeId: submission.rubricAssigneeId, reviewerId: submission.reviewerId, lastClaimedAt: submission.lastClaimedAt };
});
