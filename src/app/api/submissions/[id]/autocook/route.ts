import { route } from '@/lib/api';
import { autocookStatus, startAutocook } from '@/lib/services/autocook';

export const dynamic = 'force-dynamic';

/** Start Autocook from this task’s brief + Catalog inputs (george only). */
export const POST = route({}, async ({ actor, params }) => {
  return startAutocook(actor, params['id']!);
});

/** Poll Autocook progress; ingest deliverables into AI outputs when exported. */
export const GET = route({}, async ({ actor, params, request }) => {
  const runId = new URL(request.url).searchParams.get('runId') ?? undefined;
  return autocookStatus(actor, params['id']!, runId);
});
