import { z } from 'zod';
import { route } from '@/lib/api';
import { startHelper } from '@/lib/jobs/start';

const Body = z.object({ requestId: z.string().uuid() });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const job = await startHelper(actor, params['id']!, body);
  return { jobId: job.id, status: job.status };
});
