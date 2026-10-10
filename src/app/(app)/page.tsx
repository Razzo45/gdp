import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BoardFreshness } from '@/components/BoardFreshness';
import { ClaimTask } from '@/components/ClaimTask';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { StageBadge } from '@/components/StageBadge';
import { TimeAgo } from '@/components/TimeAgo';
import { currentActor } from '@/lib/auth/identity';
import { claimableSeat, isController } from '@/lib/auth/permissions';
import { dashboardOverview } from '@/lib/services/dashboard';
import { listSubmissions } from '@/lib/services/submissions';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (isController(actor)) return <PmDashboard actorId={actor.id} />;

  const all = await listSubmissions(actor);
  const mine = all.filter((s) => s.rubricAssigneeId === actor.id || s.reviewerId === actor.id);
  const queue = all.filter((s) => s.blinded);

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
    <PageHeader title="Your work">Tasks you hold, and the next one you can claim.</PageHeader>
    <div className="grid gap-5 lg:grid-cols-3">
      <section className="card lg:col-span-2">
        <h2 className="section-title mb-4 text-lg">Your seats ({mine.length})</h2>
        {mine.length === 0 ? (
          <p className="text-sm text-muted">
            You hold no tasks. Claim the next one from the queue — you will not see the brief until you take it.
          </p>
        ) : (
          <SeatList rows={mine} actorId={actor.id} />
        )}
      </section>
      <section className="card">
        <h2 className="section-title mb-4 text-lg">Claim queue ({queue.length})</h2>
        {queue.length === 0 ? (
          <p className="text-sm text-muted">Nothing is waiting to be claimed.</p>
        ) : (
          <ul className="divide-y divide-line">
            {queue.map((s) => {
              const seat = claimableSeat(actor, s);
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-sm text-muted">{s.stage === 'review' ? 'Review task' : 'Rubric task'}</span>
                  {seat && <ClaimTask submissionId={s.id} seat={seat} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
    </div>
    </Page>
  );
}

async function PmDashboard({ actorId }: { actorId: string }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const board = await dashboardOverview(actor);
  const mine = board.mine;

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
      <PageHeader title="Operations">
        Stuck work, throughput, and team health. Open a task, or go to{' '}
        <Link href="/submissions" className="font-semibold text-accent-text">
          GDP Evaluation
        </Link>{' '}
        for the full list.
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="In flight" value={board.inFlight} hint={board.returned > 0 ? `${board.returned} back from review` : 'Not yet submitted'} />
        <Stat label={`Stuck ≥ ${board.stuckHours}h`} value={board.stuck.length} hint="Same status too long" warn={board.stuck.length > 0} />
        <Stat label="Unassigned" value={board.unassigned} hint="No rubric seat" />
        <Stat label="Pushed this week" value={board.pushed.week} hint={`${board.pushed.month} this month`} />
        <Stat label="Pushed all time" value={board.pushed.all} hint={`${board.landed.week} landed this week`} />
      </div>

      <section className="card overflow-x-auto p-0">
        <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
          <h2 className="section-title text-lg">Stuck in one status</h2>
          <span className="text-xs text-muted">{board.stuckHours} hours or more, oldest first</span>
        </div>
        {board.stuck.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">Nothing has sat in the same status for {board.stuckHours} hours.</p>
        ) : (
          <table className="mt-3 w-full min-w-[720px] text-sm">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-2">Task</th>
                <th className="px-5 py-2">Status</th>
                <th className="px-5 py-2">Holder</th>
                <th className="px-5 py-2">In status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {board.stuck.map((row) => (
                <tr key={row.id} className="hover:bg-wash">
                  <td className="px-5 py-3">
                    <Link href={`/submissions/${row.id}`} className="font-medium hover:underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3">{row.workLabel}</td>
                  <td className="px-5 py-3">{row.holderName ?? <span className="text-quiet">Unassigned</span>}</td>
                  <td className="px-5 py-3 tabular-nums text-warn">{row.held}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
          <h2 className="section-title text-lg">Team</h2>
          <span className="text-xs text-muted">This week’s moves · stuck seats need a look</span>
        </div>
        {board.team.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">No creators or reviewers yet.</p>
        ) : (
          <table className="mt-3 w-full min-w-[800px] text-sm">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-2">Person</th>
                <th className="px-5 py-2">Signal</th>
                <th className="px-5 py-2">Holding</th>
                <th className="px-5 py-2">Stuck</th>
                <th className="px-5 py-2">Sent</th>
                <th className="px-5 py-2">Approved</th>
                <th className="px-5 py-2">Returned</th>
                <th className="px-5 py-2">Pushed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {board.team.map((row) => (
                <tr key={row.userId} className="hover:bg-wash">
                  <td className="px-5 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-[11px] text-muted">{row.roles.join(', ') || 'no role'}</div>
                  </td>
                  <td className="px-5 py-3">
                    <SignalBadge signal={row.signal} />
                  </td>
                  <td className="px-5 py-3 tabular-nums">{row.holding}</td>
                  <td className={`px-5 py-3 tabular-nums ${row.stuck > 0 ? 'text-warn' : ''}`}>{row.stuck}</td>
                  <td className="px-5 py-3 tabular-nums">{row.sentWeek}</td>
                  <td className="px-5 py-3 tabular-nums">{row.approvedWeek}</td>
                  <td className="px-5 py-3 tabular-nums">{row.returnedWeek}</td>
                  <td className="px-5 py-3 tabular-nums">{row.pushedWeek}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {mine.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer select-none font-semibold">Seats you hold ({mine.length})</summary>
          <p className="mt-1 text-sm text-muted">PMs assign work; this only appears if a seat is already on your account.</p>
          <div className="mt-3">
            <SeatList rows={mine} actorId={actorId} />
          </div>
        </details>
      )}
    </div>
    </Page>
  );
}

function Stat({ label, value, hint, warn = false }: { label: string; value: number; hint: string; warn?: boolean }) {
  return (
    <div className={`card ${warn ? 'border-warn bg-warn-soft' : 'bg-accent-wash'}`}>
      <p className="page-kicker">{label}</p>
      <p className={`mt-2 text-2xl font-semibold leading-8 tracking-[-0.025em] tabular-nums ${warn ? 'text-warn' : 'text-ink'}`}>{value}</p>
      <p className="mt-1 text-xs text-quiet">{hint}</p>
    </div>
  );
}

function SignalBadge({ signal }: { signal: 'attention' | 'moving' | 'quiet' }) {
  if (signal === 'attention') return <span className="badge badge-warn">Needs attention</span>;
  if (signal === 'moving') return <span className="badge badge-ok">Moving</span>;
  return <span className="badge badge-muted">Quiet</span>;
}

function SeatList({
  rows,
  actorId,
}: {
  rows: Awaited<ReturnType<typeof listSubmissions>>;
  actorId: string;
}) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((s) => (
        <li key={s.id} className="relative flex items-center gap-3 py-3">
          <StageBadge stage={s.stage} />
          <Link href={`/submissions/${s.id}`} className="min-w-0 flex-1 truncate font-medium after:absolute after:inset-0 hover:underline">
            {s.title || s.catalogSubmissionId}
          </Link>
          <span className="shrink-0 text-xs text-muted">
            {s.rubricAssigneeId === actorId ? 'rubric seat' : 'review seat'} · claimed{' '}
            <TimeAgo iso={s.rubricAssigneeId === actorId ? s.rubricClaimedAt : s.reviewClaimedAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}
