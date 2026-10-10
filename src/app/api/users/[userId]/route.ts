import { z } from 'zod';
import { ROLES } from '@/db/schema';
import { route } from '@/lib/api';
import { setUserActive, setUserRoles } from '@/lib/services/admin';

const Body = z.object({ roles: z.array(z.enum(ROLES)).optional(), isActive: z.boolean().optional() });

export const PATCH = route({ body: Body }, async ({ actor, body, params }) => {
  const userId = params['userId']!;
  if (body.roles) await setUserRoles(actor, userId, body.roles);
  if (body.isActive !== undefined) await setUserActive(actor, userId, body.isActive);
  return { ok: true };
});
