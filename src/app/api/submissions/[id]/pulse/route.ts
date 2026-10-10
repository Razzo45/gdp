import { route } from '@/lib/api';
import { submissionPulse } from '@/lib/services/view';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor, params }) => submissionPulse(actor, params['id']!));
