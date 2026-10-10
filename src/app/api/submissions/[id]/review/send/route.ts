import { route } from '@/lib/api';
import { sendToReview } from '@/lib/services/review';

export const POST = route({}, async ({ actor, params }) => {
  await sendToReview(actor, params['id']!);
  return { ok: true };
});
