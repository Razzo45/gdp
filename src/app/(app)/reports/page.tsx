import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { DELIVERY_TARGET_HOURS, REPORT_STATE_LABEL, REPORT_STATES, reportRange, summarizeDelivery, type ReportState } from '@/domain/reports';
import { currentActor } from '@/lib/auth/identity';
import { isController } from '@/lib/auth/permissions';
import { loadReportData } from '@/lib/services/reports';

export const dynamic = 'force-dynamic';

const CLOCK_STATES = REPORT_STATES.filter((s) => s !== 'submitted');
const QUEUE_STATES = new Set<ReportState>(['unassigned', 'review_queue']);
const SLOWEST = 15;

function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 48) return `${(value / 24).toFixed(1)} d`;
  return `${value.toFixed(1)} h`;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!isController(actor)) redirect('/');
  const params = await searchParams;
  const range = reportRange({ from: params['from'], to: params['to'] });
  const { tasks, names } = await loadReportData(actor);
  const cohort = tasks.filter((task) => {
    const landed = Date.parse(task.landedAt);
    return landed >= range.startMs && landed < range.endMs;
  });
  const summary = summarizeDelivery(cohort.map((task) => task.timeline));
  const name = (id: string) => names.get(id) ?? 'Unknown';
  const people = [...summary.people].sort(([, a], [, b]) => b.heldHours - a.heldHours);
  const slowest = cohort.toSorted((a, b) => b.timeline.totalHours - a.timeline.totalHours).slice(0, SLOWEST);
  const maxAverage = Math.max(1, ...CLOCK_STATES.map((s) => summary.averageHoursByState[s]));
  const clockTotal = CLOCK_STATES.reduce((sum, s) => sum + summary.averageHoursByState[s], 0);
  const withinPercent = summary.submitted > 0 ? Math.round((summary.submittedWithinTarget / summary.submitted) * 100) : null;
  const query = `from=${range.from}&to=${range.to}`;

  return (
    <Page>
      <div className="space-y-5">
        <PageHeader title="Reports">
          Tasks that landed between {range.from} and {range.to} (UTC), replayed from every state change. A task should leave the platform within {DELIVERY_TARGET_HOURS} hours.
        </PageHeader>

        <form className="flex flex-wrap items-end gap-2" action="/reports" method="get">
          <label className="flex flex-col gap-1 text-sm">
            From
            <input className="input" type="date" name="from" defaultValue={range.from} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            To
            <input className="input" type="date" name="to" defaultValue={range.to} />
          </label>
          <button className="btn" type="submit">
            Apply
          </button>
        </form>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Stat label="Tasks in" value={String(summary.tasks)} hint={`${summary.open} still open${summary.recovered > 0 ? ` · ${summary.recovered} restored by catch-up, timed from then` : ''}`} />
          <Stat label="Submitted" value={String(summary.submitted)} hint={`${summary.reviewReturns} review returns`} />
          <Stat
            label={`Within ${DELIVERY_TARGET_HOURS}h`}
            value={withinPercent === null ? '—' : `${withinPercent}%`}
            hint={`${summary.submittedWithinTarget} of ${summary.submitted} submitted`}
            warn={withinPercent !== null && withinPercent < 80}
          />
          <Stat label="Median to submit" value={hours(summary.medianHoursToSubmit)} hint={`Slowest 10%: ${hours(summary.p90HoursToSubmit)}`} />
          <Stat label={`Open over ${DELIVERY_TARGET_HOURS}h`} value={String(summary.openOverTarget)} hint="Still in the platform" warn={summary.openOverTarget > 0} />
          <Stat label="Platform returns" value={String(summary.platformReturns)} hint="Bounced after handoff" warn={summary.platformReturns > 0} />
        </div>

        <section className="card">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="section-title text-lg">Where the time goes</h2>
            <span className="text-xs text-muted">Average per task · waiting rows are time nobody held the task</span>
          </div>
          <ul className="mt-4 space-y-2.5">
            {CLOCK_STATES.map((state) => {
              const average = summary.averageHoursByState[state];
              const share = clockTotal > 0 ? Math.round((average / clockTotal) * 100) : 0;
              return (
                <li key={state} className="grid grid-cols-[180px_1fr_120px] items-center gap-3 text-sm">
                  <span className={QUEUE_STATES.has(state) ? 'text-muted' : 'font-medium'}>{REPORT_STATE_LABEL[state]}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-wash">
                    <span className={`block h-full rounded-full ${QUEUE_STATES.has(state) ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${(average / maxAverage) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums">
                    {hours(average)} <span className="text-muted">· {share}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
            <h2 className="section-title text-lg">People</h2>
            <span className="text-xs text-muted">Hours tasks sat with each person · round trips are re-sends to review</span>
          </div>
          {people.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">Nobody held a task that landed in this window.</p>
          ) : (
            <table className="mt-3 w-full min-w-[960px] text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-2">Person</th>
                  <th className="px-5 py-2">Tasks</th>
                  <th className="px-5 py-2">Held</th>
                  <th className="px-5 py-2">Per task</th>
                  <th className="px-5 py-2">Creating</th>
                  <th className="px-5 py-2">Reviewing</th>
                  <th className="px-5 py-2">Sent</th>
                  <th className="px-5 py-2">Round trips</th>
                  <th className="px-5 py-2">Returned to them</th>
                  <th className="px-5 py-2">Returns given</th>
                  <th className="px-5 py-2">Approved</th>
                  <th className="px-5 py-2">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {people.map(([id, row]) => {
                  const creating = row.hoursByState.preparing + row.hoursByState.review_returned + row.hoursByState.platform_returned + row.hoursByState.stability + row.hoursByState.handoff;
                  return (
                    <tr key={id} className="hover:bg-wash">
                      <td className="px-5 py-3 font-medium">
                        <a className="hover:underline" href={`/api/reports/activity?${query}&user=${id}`} title="Download this person's task history">
                          {name(id)}
                        </a>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{row.tasks}</td>
                      <td className="px-5 py-3 tabular-nums">{hours(row.heldHours)}</td>
                      <td className="px-5 py-3 tabular-nums">{hours(row.tasks > 0 ? row.heldHours / row.tasks : null)}</td>
                      <td className="px-5 py-3 tabular-nums">{hours(creating)}</td>
                      <td className="px-5 py-3 tabular-nums">{hours(row.hoursByState.in_review)}</td>
                      <td className="px-5 py-3 tabular-nums">{row.sent}</td>
                      <td className={`px-5 py-3 tabular-nums ${row.resent > 0 ? 'font-semibold text-warn' : ''}`}>{row.resent}</td>
                      <td className="px-5 py-3 tabular-nums">{row.returnsReceived}</td>
                      <td className="px-5 py-3 tabular-nums">{row.returnsGiven}</td>
                      <td className="px-5 py-3 tabular-nums">{row.approved}</td>
                      <td className="px-5 py-3 tabular-nums">{row.submitted}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
            <h2 className="section-title text-lg">Slowest tasks</h2>
            <span className="text-xs text-muted">Hours in the platform, longest first</span>
          </div>
          {slowest.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">No tasks landed in this window.</p>
          ) : (
            <table className="mt-3 w-full min-w-[820px] text-sm">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-2">Task</th>
                  <th className="px-5 py-2">Now</th>
                  <th className="px-5 py-2">In platform</th>
                  <th className="px-5 py-2">Longest state</th>
                  <th className="px-5 py-2">Round trips</th>
                  <th className="px-5 py-2">Waiting on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {slowest.map((task) => {
                  const t = task.timeline;
                  const current = t.segments.at(-1)!;
                  const longest = CLOCK_STATES.reduce((best, s) => (t.hoursByState[s] > t.hoursByState[best] ? s : best), CLOCK_STATES[0]!);
                  const over = t.totalHours > DELIVERY_TARGET_HOURS;
                  return (
                    <tr key={task.id} className="hover:bg-wash">
                      <td className="px-5 py-3">
                        <Link href={`/submissions/${task.id}`} className="font-mono font-semibold hover:underline">
                          {task.catalogSubmissionId.slice(0, 8)}
                        </Link>
                        {task.title ? <span className="mt-0.5 block max-w-xs truncate text-xs text-muted">{task.title}</span> : null}
                      </td>
                      <td className="px-5 py-3">{REPORT_STATE_LABEL[current.state]}</td>
                      <td className={`px-5 py-3 tabular-nums ${over ? 'font-semibold text-warn' : ''}`}>{hours(t.totalHours)}</td>
                      <td className="px-5 py-3">
                        {REPORT_STATE_LABEL[longest]} <span className="text-muted tabular-nums">· {hours(t.hoursByState[longest])}</span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{Math.max(0, t.reviewRounds - 1)}</td>
                      <td className="px-5 py-3">{current.state === 'submitted' ? <span className="text-quiet">Done</span> : current.holderId ? name(current.holderId) : <span className="text-muted">Nobody</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card space-y-4">
          <h2 className="section-title text-lg">Exports</h2>
          <div className="flex flex-wrap items-end gap-3">
            <a className="btn" href={`/api/reports/delivery?${query}`}>
              Delivery (Excel)
            </a>
            <p className="text-sm text-muted">One row per task that landed in the window: hours in each state, round trips, who held it.</p>
          </div>
          <form className="flex flex-wrap items-end gap-3" action="/api/reports/activity" method="get">
            <input type="hidden" name="from" value={range.from} />
            <input type="hidden" name="to" value={range.to} />
            <label className="flex flex-col gap-1 text-sm">
              Person
              <select className="input" name="user" defaultValue="">
                <option value="">Everyone</option>
                {[...names]
                  .sort(([, a], [, b]) => a.localeCompare(b))
                  .map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <button className="btn" type="submit">
              Activity (Excel)
            </button>
            <p className="text-sm text-muted">Every state change in the window. With a person: the full history of each task they held or moved.</p>
          </form>
        </section>
      </div>
    </Page>
  );
}

function Stat({ label, value, hint, warn = false }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className={`card ${warn ? 'border-warn bg-warn-soft' : 'bg-accent-wash'}`}>
      <p className="page-kicker">{label}</p>
      <p className={`mt-2 text-2xl font-semibold leading-8 tracking-[-0.025em] tabular-nums ${warn ? 'text-warn' : 'text-ink'}`}>{value}</p>
      <p className="mt-1 text-xs text-quiet">{hint}</p>
    </div>
  );
}
