import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/db/client';
import { profiles } from '@/db/schema';
import { json } from '@/lib/api';
import { LOCAL_SESSION_COOKIE, localCookieOptions, signLocalSession, verifyLocalSession } from '@/lib/auth/local';
import { hashPassword } from '@/lib/auth/passwords';
import { consumeAuthToken } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';

/** Sets a password from an invite/recovery token, or the current local session. */
export async function POST(request: Request): Promise<Response> {
  const parsed = z.object({ password: z.string().min(10).max(200), token: z.string().min(8).optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Use at least 10 characters.' }, 400);
  const configuration = env();
  if (configuration.AUTH_MODE === 'local') {
    let userId: string | null = null;
    if (parsed.data.token) {
      userId = (await consumeAuthToken(parsed.data.token, 'invite')) ?? (await consumeAuthToken(parsed.data.token, 'recover'));
    } else {
      const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
      const session = cookie ? await verifyLocalSession(cookie, configuration.AUTH_LOCAL_SECRET) : null;
      userId = session?.sub ?? null;
    }
    if (!userId) return json({ error: 'The link has expired. Request a new one.' }, 401);
    const [user] = await db()
      .update(profiles)
      .set({ passwordHash: await hashPassword(parsed.data.password) })
      .where(eq(profiles.id, userId))
      .returning();
    if (!user) return json({ error: 'The link has expired. Request a new one.' }, 401);
    const session = await signLocalSession({ id: user.id, email: user.email }, configuration.AUTH_LOCAL_SECRET);
    const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
    (await cookies()).set(LOCAL_SESSION_COOKIE, session, localCookieOptions(proto === 'https'));
    return json({ ok: true });
  }
  const supabase = await supabaseAuthClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return json({ error: 'The link has expired. Request a new one.' }, 401);
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}
