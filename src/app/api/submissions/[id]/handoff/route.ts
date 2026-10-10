import { z } from 'zod';
import { route } from '@/lib/api';
import { setHandoffStatus } from '@/lib/services/handoff';

const Body = z.object({ target: z.enum(['ready_for_review', 'bounced', 'stability_pass', 'final_review_pass']), reason: z.string().max(2000).default('') });

export const POST = route({ body: Body }, async ({ actor, body, params }) => {
  const submission = await setHandoffStatus(actor, params['id']!, body.target, body.reason);
  return { handoffStatus: submission.handoffStatus, stage: submission.stage };
});
