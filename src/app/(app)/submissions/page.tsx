import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BoardFreshness } from '@/components/BoardFreshness';
import { CatalogReturnQueue } from '@/components/CatalogReturnQueue';
import { ImportTask } from '@/components/ImportTask';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { currentActor } from '@/lib/auth/identity';
import { isController } from '@/lib/auth/permissions';
import { listPendingCatalogReturns } from '@/lib/services/catalogReturn';
import { listSubmissions } from '@/lib/services/submissions';
import { TaskLabel } from '@/components/TaskLabel';
import { TimeAgo } from '@/components/TimeAgo';
import { WorkStateChips } from '@/components/WorkStateChips';
import { WorkStatusPill } from '@/components/WorkStatusPill';
import { BOARD_STATES, WORK_STATE_HINT, WORK_STATE_LABEL, WORK_STATES, type WorkState } from '@/domain/workState';

export const dynamic = 'force-dynamic';

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const params = await searchParams;
  const workState = WORK_STATES.includes(params['state'] as WorkState) ? (params['state'] as WorkState) : undefined;
  const q = params['q']?.trim() || undefined;
  const mine = params['mine'] === '1';
  const pm = isController(actor);
  const [listedQuery, pendingReturns] = await Promise.all([
    listSubmissions(actor, { mine, q }),
    pm ? listPendingCatalogReturns(actor) : Promise.resolve([]),
  ]);
  const scoped = pm ? listedQuery : listedQuery.filter((r) => !r.blinded);
  const listed = workState ? scoped.filter((r) => r.workState === workState) : scoped;
  const countRows = q ? await listSubmissions(actor, { mine }) : listedQuery;
  const counts = Object.fromEntries(BOARD_STATES.map((s) => [s, countRows.filter((r) => r.workState === s).length])) as Record<WorkState, number>;

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
      <PageHeader
        title="Submissions"
        actions={
          pm ? (
            <>
              <Link href="/submissions" className={`chip ${!workState && !mine && !q ? 'chip-on' : ''}`}>
                All
              </Link>
              <Link href="/submissions?mine=1" className={`chip ${mine ? 'chip-on' : ''}`}>
                Mine
              </Link>
            </>
          ) : undefined
        }
      >
        {workState
          ? WORK_STATE_HINT[workState]
          : pm
            ? 'This project’s board. Claim and personal status live on the dashboard when more projects land.'
            : 'This project’s tasks you already hold. Claim from the dashboard.'}
      </PageHeader>

      {pm && <WorkStateChips counts={counts} active={workState} />}

      {pm && (
        <form className="flex flex-wrap items-end gap-2" action="/submissions" method="get">
          {workState && <input type="hidden" name="state" value={workState} />}
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
            Full or partial submission ID
            <input className="input" name="q" defaultValue={q ?? ''} placeholder="Catalog submission id or title" />
          </label>
          <button className="btn" type="submit">
            Search
          </button>
          {q && (
            <Link href={workState ? `/submissions?state=${workState}` : '/submissions'} className="btn">
              Clear
            </Link>
          )}
        </form>
      )}

      {pm && <CatalogReturnQueue items={pendingReturns} />}
      {pm && <ImportTask />}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="sticky top-0 bg-wash text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            <tr>
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Work status</th>
              <th className="px-4 py-3">Assigned to</th>
              <th className="px-4 py-3">Last interaction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {listed.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted">
                  {q ? 'No matching submissions' : workState ? `No submissions: ${WORK_STATE_LABEL[workState]}` : 'Nothing here yet'}
                </td>
              </tr>
            )}
            {listed.map((s) => {
              const assignee =
                s.workState === 'in_review'
                  ? (s.reviewerName ?? 'Review Team')
                  : (s.rubricAssigneeName ?? (s.workState === 'preparing' || s.workState === 'unassigned' || s.workState === 'review_returned' ? 'Rubric Team' : null));
              return (
              <tr key={s.id} className="relative hover:bg-wash">
                <td className="px-4 py-3.5 align-middle">
                  <Link href={`/submissions/${s.id}`} className="after:absolute after:inset-0 hover:underline">
                    <TaskLabel catalogId={s.catalogSubmissionId} title={s.title} />
                  </Link>
                </td>
                <td className="px-4 py-3.5 align-middle">
                  <WorkStatusPill state={s.workState} size="board" />
                </td>
                <td className="px-4 py-3.5 align-middle">
                  {assignee ? <span className="text-sm font-semibold leading-[22px]">{assignee}</span> : <span className="text-quiet">—</span>}
                </td>
                <td className="px-4 py-3.5 align-middle text-xs leading-[18px] text-muted">
                  <TimeAgo iso={s.lastSeenAt} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    </Page>
  );
}
