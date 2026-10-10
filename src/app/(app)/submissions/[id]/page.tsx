import { notFound, redirect } from 'next/navigation';
import { ClaimTask } from '@/components/ClaimTask';
import { Page } from '@/components/Page';
import { TaskWorkspace } from '@/components/task/TaskWorkspace';
import { currentActor } from '@/lib/auth/identity';
import { listUsers } from '@/lib/services/admin';
import { ServiceError } from '@/lib/services/errors';
import { peekClaim } from '@/lib/services/submissions';
import { submissionView } from '@/lib/services/view';

export const dynamic = 'force-dynamic';

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const { id } = await params;
  try {
    const view = await submissionView(actor, id);
    const people = view.can.control ? await listUsers(actor) : [];
    return (
      <Page fill>
        <TaskWorkspace initial={view} actorId={actor.id} assignable={people.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.displayName ?? p.email, roles: p.roles }))} />
      </Page>
    );
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    if (error instanceof ServiceError && error.status === 403) {
      const offer = await peekClaim(actor, id);
      if (offer) {
        return (
          <Page>
            <div className="card space-y-3">
              <h1 className="text-lg font-semibold">Unclaimed {offer.seat === 'review' ? 'review' : 'rubric'} task</h1>
              <p className="text-sm text-muted">Claim it to open the brief. You will not see the descriptor until you take the seat, so work is not chosen by title.</p>
              <ClaimTask submissionId={id} seat={offer.seat} label="Claim this task" />
            </div>
          </Page>
        );
      }
      return (
        <Page>
          <p className="card text-sm text-muted">{error.message}</p>
        </Page>
      );
    }
    throw error;
  }
}
