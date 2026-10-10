import { route } from '@/lib/api';
import { claimsOverview } from '@/lib/services/submissions';

export const dynamic = 'force-dynamic';

/** PM view: who holds which tasks, with claim and landing timestamps. */
export const GET = route({}, async ({ actor }) => ({ people: await claimsOverview(actor) }));
