import { z } from 'zod';
import { route } from '@/lib/api';
import { saveCalibration } from '@/lib/services/review';

const Body = z.object({
  answers: z.record(z.string().uuid(), z.boolean()),
  evidence: z.record(z.string().uuid(), z.string().max(1000)).default({}),
  submit: z.boolean().default(false),
});

export const PUT = route({ body: Body }, async ({ actor, body, params }) => {
  const row = await saveCalibration(actor, params['id']!, body);
  return { id: row.id, scorePercent: row.scorePercent, submitted: row.submitted };
});
