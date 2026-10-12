import { route } from '@/lib/api';
import { listPendingCatalogReturns } from '@/lib/services/catalogReturn';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor }) => ({
  returns: await listPendingCatalogReturns(actor),
}));
