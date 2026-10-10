import { z } from 'zod';
import { ROLES } from '@/db/schema';
import { route } from '@/lib/api';
import { inviteUser, listUsers } from '@/lib/services/admin';

export const dynamic = 'force-dynamic';

export const GET = route({}, async ({ actor }) => ({ users: await listUsers(actor) }));

const Body = z.object({ email: z.string().email(), roles: z.array(z.enum(ROLES)).default([]), displayName: z.string().max(120).optional() });

export const POST = route({ body: Body }, async ({ actor, body, request }) => ({ user: await inviteUser(actor, body, new URL(request.url).origin) }));
