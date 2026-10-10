import { z } from 'zod';
import { route } from '@/lib/api';
import { removeWatchedProject, updateWatchedProject } from '@/lib/services/admin';

const Body = z.object({ workStatusId: z.string().max(200).optional(), handoffStatusId: z.string().max(200).optional(), label: z.string().max(200).optional() });

export const PATCH = route({ body: Body }, async ({ actor, body, params }) => ({ project: await updateWatchedProject(actor, params['projectId']!, body) }));

export const DELETE = route({}, async ({ actor, params }) => {
  await removeWatchedProject(actor, params['projectId']!);
  return { ok: true };
});
