import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BoardFreshness } from '@/components/BoardFreshness';
import { ClaimTask } from '@/components/ClaimTask';
import { ImportTask } from '@/components/ImportTask';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { currentActor } from '@/lib/auth/identity';
import { claimableSeat, isController } from '@/lib/auth/permissions';
import { listSubmissions } from '@/lib/services/submissions';
import { TaskLabel } from '@/components/TaskLabel';
import { TimeAgo } from '@/components/TimeAgo';
import { WorkStateChips } from '@/components/WorkStateChips';
import { WorkStatusPill } from '@/components/WorkStatusPill';
import { BOARD_STATES, platformStateChangedAt, WORK_STATE_HINT, WORK_STATE_LABEL, WORK_STATES, type WorkState } from '@/domain/workState';

export const dynamic = 'force-dynamic';

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const params = await searchParams;
  const workState = WORK_STATES.includes(params['state'] as WorkState) ? (params['state'] as WorkState) : undefined;
  const q = params['q']?.trim() || undefined;
  const mine = params['mine'] === '1';
  const pm = isController(actor);
  const rows = await listSubmissions(actor, { workState, q, mine });
  const all = workState || q ? await listSubmissions(actor, { mine }) : rows;
  const counts = Object.fromEntries(BOARD_STATES.map((s) => [s, all.filter((r) => r.workState === s).length])) as Record<WorkState, number>;
  const listed = workState || q ? rows : rows.filter((row) => row.workState !== 'other');

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
      <PageHeader
        title="Submissions"
        actions={
          <>
            <Link href="/submissions" className={`chip ${!workState && !mine && !q ? 'chip-on' : ''}`}>
              All
            </Link>
            <Link href="/submissions?mine=1" className={`chip ${mine ? 'chip-on' : ''}`}>
              Mine
            </Link>
          </>
        }
      >
        {workState ? WORK_STATE_HINT[workState] : pm ? 'Tasks from the Data Catalog this team is grading.' : 'Your claimed work, plus a blind queue of tasks you can take.'}
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

      {pm && <ImportTask />}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="sticky top-0 bg-wash text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            <tr>
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Work status</th>
              <th className="px-4 py-3">Assigned to</th>
              <th className="px-4 py-3">State changed</th>
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
              const seat = s.blinded ? claimableSeat(actor, s) : null;
              const assignee =
                s.workState === 'in_review'
                  ? (s.reviewerName ?? 'Review Team')
                  : (s.rubricAssigneeName ?? (s.workState === 'preparing' || s.workState === 'unassigned' || s.workState === 'review_returned' ? 'Rubric Team' : null));
              return (
              <tr key={s.id} className="relative hover:bg-wash">
                <td className="px-4 py-3.5 align-middle">
                  {s.blinded ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{s.stage === 'review' ? 'Unclaimed review task' : 'Unclaimed rubric task'}</span>
                      {seat && <ClaimTask submissionId={s.id} seat={seat} />}
                    </div>
                  ) : (
                    <Link href={`/submissions/${s.id}`} className="after:absolute after:inset-0 hover:underline">
                      <TaskLabel catalogId={s.catalogSubmissionId} title={s.title} />
                    </Link>
                  )}
                </td>
                <td className="px-4 py-3.5 align-middle">
                  <WorkStatusPill state={s.workState} size="board" />
                </td>
                <td className="px-4 py-3.5 align-middle">
                  {s.blinded || !assignee ? <span className="text-quiet">—</span> : <span className="text-sm font-semibold leading-[22px]">{assignee}</span>}
                </td>
                <td className="px-4 py-3.5 align-middle text-xs leading-[18px] text-muted">
                  {s.blinded ? '—' : <TimeAgo iso={platformStateChangedAt(s)} />}
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
