import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell, type NavLink } from '@/components/AppShell';
import { FetchShortcut } from '@/components/FetchShortcut';
import { currentActor } from '@/lib/auth/identity';
import { canManageUsers, isController } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const roles = [...actor.roles].sort().join(', ') || 'no role yet';
  const links: NavLink[] = [
    { href: '/', label: 'Dashboard', group: 'Operations' },
    { href: '/submissions', label: 'GDP Evaluation', group: 'Operations' },
  ];
  if (isController(actor)) {
    links.push({ href: '/submissions/claims', label: 'Who holds what', group: 'Operations' });
    links.push({ href: '/reports', label: 'Reports', group: 'Operations' });
  }
  if (canManageUsers(actor)) {
    links.push({ href: '/settings/users', label: 'Settings', group: 'Administration' });
  }

  return (
    <AppShell name={actor.displayName ?? actor.email} email={actor.email} roles={roles} links={links}>
      {children}
      {isController(actor) && <FetchShortcut />}
    </AppShell>
  );
}
