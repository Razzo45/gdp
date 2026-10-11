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
  const rows = await listSubmissions(actor, { workState, q, mine });
  const all = workState || q ? await listSubmissions(actor, { mine }) : rows;
  const counts = Object.fromEntries(BOARD_STATES.map((s) => [s, all.filter((r) => r.workState === s).length])) as Record<WorkState, number>;

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
        <table className="w-full min-w-[720px] text-sm">
          <thead className="sticky top-0 bg-wash text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Submission</th>
              <th className="px-4 py-3">Work status</th>
              <th className="px-4 py-3">Assigned to</th>
              <th className="px-4 py-3">Catalog stage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted">
                  {q ? 'No matching submissions' : workState ? `No submissions: ${WORK_STATE_LABEL[workState]}` : 'Nothing here yet'}
                </td>
              </tr>
            )}
            {rows.map((s) => {
              const seat = s.blinded ? claimableSeat(actor, s) : null;
              return (
              <tr key={s.id} className="relative hover:bg-wash">
                <td className="px-4 py-3">
                  {s.blinded ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.stage === 'review' ? 'Unclaimed review task' : 'Unclaimed rubric task'}</span>
                      {seat && <ClaimTask submissionId={s.id} seat={seat} />}
                    </div>
                  ) : (
                    <>
                      <Link href={`/submissions/${s.id}`} className="font-medium after:absolute after:inset-0 hover:underline">
                        {s.title || s.catalogSubmissionId}
                      </Link>
                      <div className="font-mono text-[11px] text-muted">
                        {s.catalogSubmissionId.slice(0, 8)} · {s.projectId}
                        {s.upstreamChangedAt && s.upstreamChangedAt > s.landedAt ? ' · upstream changed' : ''}
                      </div>
                    </>
                  )}
                </td>
                <td className="px-4 py-3">
                  <WorkStatusPill state={s.workState} />
                </td>
                <td className="px-4 py-3">
                  {s.blinded ? (
                    <span className="text-quiet">—</span>
                  ) : s.workState === 'in_review' ? (
                    s.reviewerName ?? 'Reviewer Team'
                  ) : (
                    s.rubricAssigneeName ?? (s.workState === 'preparing' ? 'Rubric Team' : <span className="text-quiet">—</span>)
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-muted">{s.blinded ? '—' : s.catalogStatusName ?? '—'}</td>
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
