import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Page } from '@/components/Page';
import { currentActor } from '@/lib/auth/identity';
import { canManageUsers } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canManageUsers(actor)) redirect('/');
  return (
    <Page>
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="w-full shrink-0 space-y-1 lg:w-52">
          <h2 className="page-kicker px-3">Settings</h2>
          <Link href="/settings/users" className="nav-link">
            Users
          </Link>
          <Link href="/settings/projects" className="nav-link">
            Integrations
          </Link>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </Page>
  );
}
