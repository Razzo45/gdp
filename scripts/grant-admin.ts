import './env';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, userRoles } from '@/db/schema';
import { hashPassword } from '@/lib/auth/passwords';
import { env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * `npm run db:grant-admin -- someone@example.com [password]`
 * Local/Railway: creates the profile and admin role. Password is optional.
 * Supabase: invites the Auth user if needed, then grants admin.
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.argv[3];
  if (!email) {
    console.error('Usage: npm run db:grant-admin -- <email> [password]');
    process.exit(2);
  }
  const database = db();
  if (env().AUTH_MODE === 'local') {
    const existing = (await database.select().from(profiles).where(eq(profiles.email, email)).limit(1))[0];
    const id = existing?.id ?? crypto.randomUUID();
    await database
      .insert(profiles)
      .values({ id, email, passwordHash: password ? await hashPassword(password) : existing?.passwordHash ?? null })
      .onConflictDoUpdate({
        target: profiles.id,
        set: { isActive: true, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
      });
    const grants = await database.select().from(userRoles).where(eq(userRoles.userId, id));
    if (!grants.some((r) => r.role === 'admin')) await database.insert(userRoles).values({ userId: id, role: 'admin' });
    console.log(password ? `${email} is an admin with a password.` : `${email} is an admin. They set a password on first sign-in.`);
    process.exit(0);
  }
  const admin = supabaseAdmin();
  const page = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  let user = page.data.users.find((u) => u.email?.toLowerCase() === email);
  if (!user) {
    const invited = await admin.auth.admin.inviteUserByEmail(email);
    if (invited.error || !invited.data.user) throw new Error(invited.error?.message ?? 'invite failed');
    user = invited.data.user;
    console.log(`Invite sent to ${email}.`);
  }
  await database.insert(profiles).values({ id: user.id, email }).onConflictDoUpdate({ target: profiles.id, set: { isActive: true } });
  const existing = await database.select().from(userRoles).where(eq(userRoles.userId, user.id));
  if (!existing.some((r) => r.role === 'admin')) await database.insert(userRoles).values({ userId: user.id, role: 'admin' });
  console.log(`${email} is an admin.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
