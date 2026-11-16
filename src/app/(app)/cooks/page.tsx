import { redirect } from 'next/navigation';
import { CooksPanel } from '@/components/CooksPanel';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { canAutocookEmail } from '@/domain/autocook';
import { currentActor } from '@/lib/auth/identity';

export const dynamic = 'force-dynamic';

export default async function CooksPage() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canAutocookEmail(actor.email)) redirect('/');

  return (
    <Page>
      <div className="space-y-5">
        <PageHeader title="Cooks">Your Autocook runs. Status updates on its own. Cancel is the same control as Delete on a run.</PageHeader>
        <CooksPanel />
      </div>
    </Page>
  );
}
