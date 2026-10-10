import { route } from '@/lib/api';
import { submissionView } from '@/lib/services/view';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor, params }) => submissionView(actor, params['id']!));
