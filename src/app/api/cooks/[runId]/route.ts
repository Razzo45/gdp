import { route } from '@/lib/api';
import { cancelOperatorCook, retryOperatorCook } from '@/lib/services/autocook';

export const dynamic = 'force-dynamic';

export const DELETE = route({}, async ({ actor, params }) => {
  await cancelOperatorCook(actor, params['runId'] ?? '');
  return { ok: true };
});

export const POST = route({}, async ({ actor, params }) => {
  await retryOperatorCook(actor, params['runId'] ?? '');
  return { ok: true };
});
