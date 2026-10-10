import { z } from 'zod';
import { route } from '@/lib/api';
import { addWatchedProject, listWatchedProjects } from '@/lib/services/admin';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor }) => ({ projects: await listWatchedProjects(actor) }));

export const POST = route({ body: z.object({ projectId: z.string().trim().min(1).max(200) }) }, async ({ actor, body }) => ({ project: await addWatchedProject(actor, body.projectId) }));
