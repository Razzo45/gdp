import { route } from '@/lib/api';
import { pushToCatalog } from '@/lib/services/handoff';

export const POST = route({}, async ({ actor, params }) => pushToCatalog(actor, params['id']!));
