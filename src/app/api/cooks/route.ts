import { route } from '@/lib/api';
import { listOperatorCooks } from '@/lib/services/autocook';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor }) => {
  const cooks = await listOperatorCooks(actor);
  return { cooks };
});
