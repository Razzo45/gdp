import { z } from 'zod';
import { MAX_ROUGH_CHARS, MAX_SEEDS } from '@/domain/rubric';
import { route } from '@/lib/api';
import { startRubricGeneration } from '@/lib/jobs/start';

const Body = z.object({
  requestId: z.string().uuid(),
  seedMode: z.enum(['rough', 'expert']).optional(),
  /** Whole notes blob when seedMode is rough. */
  source: z.string().max(MAX_ROUGH_CHARS).default(''),
  seeds: z.array(z.string().trim().min(1).max(MAX_ROUGH_CHARS)).max(MAX_SEEDS).default([]),
  target: z.number().int().min(40).max(60).optional(),
});

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const job = await startRubricGeneration(actor, params['id']!, body);
  return { jobId: job.id, status: job.status };
});
