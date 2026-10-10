import { z } from 'zod';
import { route } from '@/lib/api';
import { startGoldenAutorate } from '@/lib/jobs/start';

const Body = z.object({ requestId: z.string().uuid(), statementIds: z.array(z.string().uuid()).max(200).optional() });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const job = await startGoldenAutorate(actor, params['id']!, body);
  return { jobId: job.id, status: job.status };
});
