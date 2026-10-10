import { redirect } from 'next/navigation';
import { ProjectsAdmin } from '@/components/settings/ProjectsAdmin';
import { currentActor } from '@/lib/auth/identity';
import { canManageUsers } from '@/lib/auth/permissions';
import { listWatchedProjects } from '@/lib/services/admin';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canManageUsers(actor)) redirect('/');
  return <ProjectsAdmin initial={await listWatchedProjects(actor)} />;
}
