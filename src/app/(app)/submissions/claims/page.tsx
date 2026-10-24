import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BoardFreshness } from '@/components/BoardFreshness';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { StageBadge } from '@/components/StageBadge';
import { TimeAgo } from '@/components/TimeAgo';
import { TaskLabel } from '@/components/TaskLabel';
import { formatDate } from '@/components/format';
import { seatIsStale, STALE_HOLD_HOURS } from '@/domain/workState';
import { currentActor } from '@/lib/auth/identity';
import { canOversee } from '@/lib/auth/permissions';
import { claimsOverview } from '@/lib/services/submissions';

export const dynamic = 'force-dynamic';

/** PM view: who holds what, oldest seats first, stale after 48 hours. */
export default async function ClaimsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canOversee(actor)) redirect('/');
  const people = await claimsOverview(actor);
  const now = Date.now();
  const holding = people
    .filter((p) => p.rubricSeats.length + p.reviewSeats.length > 0)
    .map((p) => {
      const seats = [
        ...p.rubricSeats.map((s) => ({ ...s, seat: 'rubric' as const })),
        ...p.reviewSeats.map((s) => ({ ...s, seat: 'review' as const })),
      ].sort((a, b) => Date.parse(a.claimedAt ?? a.landedAt) - Date.parse(b.claimedAt ?? b.landedAt));
      return { ...p, seats, oldest: seats[0]?.claimedAt ?? seats[0]?.landedAt ?? null };
    })
    .sort((a, b) => Date.parse(a.oldest ?? '') - Date.parse(b.oldest ?? ''));
  const idle = people.filter((p) => p.rubricSeats.length + p.reviewSeats.length === 0 && p.roles.length > 0);
  const staleCount = holding.reduce((n, p) => n + p.seats.filter((s) => seatIsStale(s, now)).length, 0);

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
      <PageHeader title="Who holds what">
        Oldest seats first. A seat held {STALE_HOLD_HOURS} hours or more is stale. Delivered seats are not.
        {staleCount > 0 ? ` ${staleCount} stale now.` : ''}
      </PageHeader>
      {holding.length === 0 && <p className="card text-sm text-muted">Nobody holds a task right now.</p>}
      {holding.map((p) => (
        <section key={p.userId} className="card">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="font-semibold">{p.name}</h2>
            <span className="text-xs text-muted">
              {p.email} · {p.roles.join(', ')}
            </span>
            <span className="ml-auto text-sm tabular-nums">
              {p.rubricSeats.length} rubric · {p.reviewSeats.length} review
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3">Seat</th>
                <th className="py-1 pr-3">Task</th>
                <th className="py-1 pr-3">Stage</th>
                <th className="py-1 pr-3">Landed</th>
                <th className="py-1">Held since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {p.seats.map((s) => {
                const stale = seatIsStale(s, now);
                return (
                <tr key={`${s.seat}-${s.submissionId}`}>
                  <td className="py-1.5 pr-3 capitalize">{s.seat}</td>
                  <td className="py-1.5 pr-3">
                    <Link href={`/submissions/${s.submissionId}`} className="hover:underline">
                      <TaskLabel catalogId={s.catalogSubmissionId} hero={s.heroDeliverable} size="compact" />
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">
                    <StageBadge stage={s.stage} />
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-muted">{formatDate(s.landedAt)}</td>
                  <td className="py-1.5 text-xs text-muted">
                    <TimeAgo iso={s.claimedAt} />
                    {stale && <span className="badge badge-warn ml-2 align-middle">Stale</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      {idle.length > 0 && (
        <p className="text-xs text-muted">
          Holding nothing: {idle.map((p) => p.name).join(', ')}
        </p>
      )}
    </div>
    </Page>
  );
}
