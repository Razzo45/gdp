import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { authTokens } from '@/db/schema';

export type AuthTokenPurpose = 'invite' | 'recover';

export function hashAuthToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function issueAuthToken(userId: string, purpose: AuthTokenPurpose, ttlMs = 48 * 60 * 60_000): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db().insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashAuthToken(raw),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return raw;
}

export async function consumeAuthToken(raw: string, purpose: AuthTokenPurpose): Promise<string | null> {
  const tokenHash = hashAuthToken(raw);
  const now = new Date().toISOString();
  const row = (
    await db()
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)))
      .limit(1)
  )[0];
  if (!row || row.expiresAt <= now) return null;
  const updated = await db()
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
    .returning({ userId: authTokens.userId });
  return updated[0]?.userId ?? null;
}
