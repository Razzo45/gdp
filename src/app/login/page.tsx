import { Suspense } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { ThemeToggle } from '@/components/ThemeToggle';
import { db } from '@/db/client';
import { profiles, userRoles } from '@/db/schema';
import { env } from '@/lib/env';
import { LoginForm, type LocalUser } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const local = env().AUTH_MODE === 'local';
  const shared = local ? env().AUTH_LOCAL_PASSWORD : undefined;
  let users: LocalUser[] = [];
  let problem: string | null = null;
  if (local && shared) {
    try {
      const database = db();
      const people = await database.select().from(profiles).orderBy(profiles.email);
      const grants = await database.select().from(userRoles);
      users = people.filter((p) => p.isActive).map((p) => ({ email: p.email, name: p.displayName ?? p.email, roles: grants.filter((g) => g.userId === p.id).map((g) => g.role) }));
    } catch (error) {
      // Not migrated yet or unreachable: show the hint rather than a 500.
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  return (
    <main className="relative flex h-dvh justify-center overflow-y-auto bg-paper px-6 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="m-auto w-full max-w-md">
        <BrandMark />
        <p className="page-kicker mt-5">Wirestock</p>
        <h1 className="page-title mt-1">Golden Data Program</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {shared
            ? 'Local development mode — pick a seeded user.'
            : local
              ? 'Use the same password as the live Wirestock GDP login. The first successful sign-in stores it here.'
              : 'Sign in with your Wirestock GDP account.'}
        </p>
        {problem ? (
          <p className="mb-4 rounded-3xl border border-warn bg-warn-soft p-3 text-xs text-warn">
            Database not ready: {problem}. Run <code>npm run db:migrate</code> then <code>npm run db:seed</code>.
          </p>
        ) : null}
        <Suspense>
          <LoginForm localUsers={shared ? users : null} localPassword={shared ?? null} />
        </Suspense>
      </div>
    </main>
  );
}
