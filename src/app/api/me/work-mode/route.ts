import { z } from 'zod';
import { cookies } from 'next/headers';
import { json, route } from '@/lib/api';
import { usesWorkMode, WORK_MODE_COOKIE, WORK_MODES } from '@/domain/workMode';
import { forbidden } from '@/lib/services/errors';

export const dynamic = 'force-dynamic';

const Body = z.object({
  mode: z.enum(WORK_MODES),
});

/** Dual-role hat switch. Cookie is read by the home board RSC. */
export const POST = route({ body: Body }, async ({ actor, body }) => {
  if (!usesWorkMode(actor)) throw forbidden('Only dual-role accounts switch between Rubric and Review.');
  const jar = await cookies();
  jar.set(WORK_MODE_COOKIE, body.mode, {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  });
  return json({ mode: body.mode });
});
