import 'server-only';

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, userRoles, type Role } from '@/db/schema';
import { bootstrapAdminEmails, env } from '@/lib/env';
import { supabaseAuthClient } from '@/lib/supabase/server';
import { VERIFIED_EMAIL_HEADER, VERIFIED_USER_HEADER } from './headerNames';
import { verifyAccessToken } from './jwt';
import { LOCAL_SESSION_COOKIE, verifyLocalSession } from './local';
import { supabaseAuthConfig } from './supabasePublic';
import type { Actor } from './permissions';

/**
 * Roles change rarely; a 60s in-memory cache keyed by user id removes the
 * per-request role query. Admin role changes call `forgetActor` so the
 * affected user sees the change immediately on this instance.
 */
const ROLE_TTL_MS = 60_000;
const actorCache = new Map<string, { actor: Actor; until: number }>();

export function forgetActor(userId: string): void {
  actorCache.delete(userId);
}

async function loadActor(userId: string, email: string | null): Promise<Actor | null> {
  const now = Date.now();
  const hit = actorCache.get(userId);
  if (hit && hit.until > now) return hit.actor;

  const database = db();
  let profile = (await database.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
  if (!profile) {
    if (!email) return null;
    // First sign-in: the Auth user exists, the app profile does not yet.
    const grantAdmin = bootstrapAdminEmails().has(email.toLowerCase());
    await database.transaction(async (tx) => {
      await tx.insert(profiles).values({ id: userId, email }).onConflictDoNothing();
      if (grantAdmin) await tx.insert(userRoles).values({ userId, role: 'admin' }).onConflictDoNothing();
    });
    profile = (await database.select().from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
    if (!profile) return null;
  }
  const roleRows = await database.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
  const actor: Actor = {
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    roles: new Set<Role>(roleRows.map((r) => r.role)),
    isActive: profile.isActive,
  };
  actorCache.set(userId, { actor, until: now + ROLE_TTL_MS });
  return actor;
}

/**
 * The signed-in actor for this request, or null.
 *
 * The proxy has already verified the access token and forwarded the subject
 * in a header it strips from inbound requests. Should a route ever run
 * without the proxy, the cookie is verified here instead — still locally.
 */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const list = await headers();
  let userId = list.get(VERIFIED_USER_HEADER);
  let email = list.get(VERIFIED_EMAIL_HEADER);
  if (!userId) {
    const configuration = env();
    if (configuration.AUTH_MODE === 'local') {
      const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
      const session = cookie ? await verifyLocalSession(cookie, configuration.AUTH_LOCAL_SECRET) : null;
      if (!session) return null;
      userId = session.sub;
      email = session.email;
    } else {
      const supabase = await supabaseAuthClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return null;
      const claims = await verifyAccessToken(token, { supabaseUrl: supabaseAuthConfig().url, jwtSecret: configuration.SUPABASE_JWT_SECRET });
      if (!claims) return null;
      userId = claims.sub;
      email = claims.email;
    }
  }
  const actor = await loadActor(userId, email);
  if (!actor || !actor.isActive) return null;
  return actor;
});

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new AuthError(401, 'Sign in to continue.');
  return actor;
}
