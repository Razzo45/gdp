import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/db/client';
import { profiles, userRoles } from '@/db/schema';
import { json } from '@/lib/api';
import { bootstrapAdminEmails, env } from '@/lib/env';
import { localCookieOptions, LOCAL_SESSION_COOKIE, signLocalSession } from '@/lib/auth/local';
import { verifyLivePassword } from '@/lib/auth/livePassword';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';
import { supabaseAuthClient } from '@/lib/supabase/server';

/**
 * Password sign-in. Supabase Auth verifies the credentials and the SSR
 * client writes the session cookies; from here on the proxy verifies the
 * token locally on each request — no further Auth round-trips until the
 * token nears expiry.
 *
 * AUTH_MODE=local: per-user password_hash on app.profiles. If a profile has
 * no hash yet, the live Supabase password is checked once and stored as
 * scrypt. BOOTSTRAP_ADMIN_EMAILS can still set a first password. Shared
 * AUTH_LOCAL_PASSWORD is laptop-only. We mint our own cookie.
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
    const user = await ensureLocalUser(email.toLowerCase(), password, configuration.AUTH_LOCAL_PASSWORD ?? '');
    if (!user) return refuse();
    const token = await signLocalSession({ id: user.id, email: user.email }, configuration.AUTH_LOCAL_SECRET);
    const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
    (await cookies()).set(LOCAL_SESSION_COOKIE, token, localCookieOptions(proto === 'https'));
    attempts.delete(key);
    return json({ ok: true });
  }

  try {
    const supabase = await supabaseAuthClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (/confirm/i.test(error.message)) return json({ error: 'Confirm this email before signing in.' }, 401);
      return refuse();
    }
    attempts.delete(key);
    return json({ ok: true });
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Sign-in is not configured.';
    return json({ error: text.includes('not configured') ? text : 'Sign-in is not configured.' }, 503);
  }
}

async function ensureLocalUser(email: string, password: string, shared: string) {
  const database = db();
  let user = (await database.select().from(profiles).where(eq(profiles.email, email)).limit(1))[0];
  if (user?.passwordHash) {
    if (!(await verifyPassword(password, user.passwordHash)) || !user.isActive) return null;
    return user;
  }
  if (user?.isActive && (await verifyLivePassword(email, password))) {
    const [updated] = await database
      .update(profiles)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(profiles.id, user.id))
      .returning();
    return updated ?? user;
  }
  if (shared) {
    const expected = Buffer.from(shared);
    const given = Buffer.from(password);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (!user || !user.isActive) return null;
    return user;
  }
  if (password.length < 10 || !bootstrapAdminEmails().has(email)) return null;
  if (!user) {
    const id = crypto.randomUUID();
    await database.transaction(async (tx) => {
      await tx.insert(profiles).values({ id, email, passwordHash: await hashPassword(password) });
      await tx.insert(userRoles).values({ userId: id, role: 'admin' });
    });
    user = (await database.select().from(profiles).where(eq(profiles.email, email)).limit(1))[0];
    return user ?? null;
  }
  if (!user.isActive) return null;
  const [updated] = await database
    .update(profiles)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(profiles.id, user.id))
    .returning();
  return updated ?? null;
}
