import { z } from 'zod';
import { route } from '@/lib/api';
import { startStabilityRun } from '@/lib/jobs/start';

export const POST = route({ body: z.object({ requestId: z.string().uuid() }) }, async ({ actor, body, params }) => {
  const job = await startStabilityRun(actor, params['id']!, body);
  return { jobId: job.id, status: job.status };
});
