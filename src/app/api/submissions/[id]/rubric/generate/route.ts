import { z } from 'zod';
import { MAX_ROUGH_CHARS } from '@/domain/rubric';
import { route } from '@/lib/api';
import { startRubricGeneration } from '@/lib/jobs/start';

const Body = z.object({
  requestId: z.string().uuid(),
  source: z.string().max(MAX_ROUGH_CHARS).default(''),
  target: z.number().int().min(40).max(60).optional(),
});

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const job = await startRubricGeneration(actor, params['id']!, body);
  return { jobId: job.id, status: job.status };
});
