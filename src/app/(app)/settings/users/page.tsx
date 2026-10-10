import { redirect } from 'next/navigation';
import { UsersAdmin } from '@/components/settings/UsersAdmin';
import { currentActor } from '@/lib/auth/identity';
import { canManageUsers } from '@/lib/auth/permissions';
import { listUsers } from '@/lib/services/admin';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canManageUsers(actor)) redirect('/');
  return <UsersAdmin initial={await listUsers(actor)} selfId={actor.id} />;
}
