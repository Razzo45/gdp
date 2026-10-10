import './env';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, userRoles } from '@/db/schema';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * `npm run db:grant-admin -- someone@example.com`
 * Creates the Auth user if needed (sends an invite), ensures the profile,
 * and grants the admin role. For first-time setup when no admin exists.
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run db:grant-admin -- <email>');
    process.exit(2);
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
  const database = db();
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
