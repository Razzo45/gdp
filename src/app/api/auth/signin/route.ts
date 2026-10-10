import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/db/client';
import { profiles } from '@/db/schema';
import { json } from '@/lib/api';
import { localCookieOptions, LOCAL_SESSION_COOKIE, signLocalSession } from '@/lib/auth/local';
import { env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';

/**
 * Password sign-in. Supabase Auth verifies the credentials and the SSR
 * client writes the session cookies; from here on the proxy verifies the
 * token locally on each request — no further Auth round-trips until the
 * token nears expiry.
 *
 * AUTH_MODE=local: the email must be a seeded app.profiles row and the
 * password the shared AUTH_LOCAL_PASSWORD; we mint our own cookie.
 */

const Body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

// Tiny in-memory throttle per IP+email; Supabase enforces its own limits too.
const attempts = new Map<string, { count: number; until: number }>();

export async function POST(request: Request): Promise<Response> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Enter your email and password.' }, 400);
  const { email, password } = parsed.data;
  const key = `${request.headers.get('x-forwarded-for') ?? 'local'}|${email.toLowerCase()}`;
  const now = Date.now();
  const bucket = attempts.get(key);
  if (bucket && bucket.until > now && bucket.count >= 8) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const refuse = () => {
    attempts.set(key, { count: (bucket && bucket.until > now ? bucket.count : 0) + 1, until: now + 10 * 60_000 });
    return json({ error: 'That email and password do not match.' }, 401);
  };

  const configuration = env();
  if (configuration.AUTH_MODE === 'local') {
    const expected = Buffer.from(configuration.AUTH_LOCAL_PASSWORD);
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return refuse();
    const user = (await db().select().from(profiles).where(eq(profiles.email, email.toLowerCase())).limit(1))[0];
    if (!user || !user.isActive) return refuse();
    const token = await signLocalSession({ id: user.id, email: user.email }, configuration.AUTH_LOCAL_SECRET);
    (await cookies()).set(LOCAL_SESSION_COOKIE, token, localCookieOptions(new URL(request.url).protocol === 'https:'));
    attempts.delete(key);
    return json({ ok: true });
  }

  const supabase = await supabaseAuthClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return refuse();
  attempts.delete(key);
  return json({ ok: true });
}
