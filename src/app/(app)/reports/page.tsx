import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { DELIVERY_TARGET_HOURS, REPORT_STATE_LABEL, REPORT_STATES, reportRange, summarizeDelivery, type ReportState, type ReportTask } from '@/domain/reports';
import { currentActor } from '@/lib/auth/identity';
import { canOversee } from '@/lib/auth/permissions';
import { loadReportData } from '@/lib/services/reports';

export const dynamic = 'force-dynamic';

const CLOCK_STATES = REPORT_STATES.filter((s) => s !== 'submitted');
const QUEUE_STATES = new Set<ReportState>(['unassigned', 'review_queue']);
const SLOWEST_SUBMITTED = 10;
const QUICK_RANGES = [7, 14, 30, 90];
const DAY_MS = 86_400_000;

const STATE_MEANING: Record<ReportState, string> = {
  unassigned: 'Nobody has claimed it yet',
  preparing: 'Creator building the rubric',
  review_queue: 'Sent to review, no reviewer has picked it up',
  in_review: 'Reviewer checking it',
  review_returned: 'Sent back by review, creator fixing it',
  stability: 'Approved, final checks before handoff',
  handoff: 'Ready, waiting to be submitted',
  platform_returned: 'Returned by the platform after submitting',
  submitted: 'Submitted',
};

const PILL: Record<ReportState, string> = {
  unassigned: 'work-pill-unassigned',
  preparing: 'work-pill-preparing',
  review_queue: 'work-pill-unassigned',
  in_review: 'work-pill-in_review',
  review_returned: 'work-pill-review_returned',
  stability: 'work-pill-stability',
  handoff: 'work-pill-handoff',
  platform_returned: 'work-pill-platform_returned',
  submitted: 'work-pill-submitted',
};

/** 45m, 6.5h, 14h, 3d 4h. */
function duration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest === 24 ? `${days + 1}d` : rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
const shortId = (task: ReportTask) => task.catalogSubmissionId.slice(0, 8);

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (!canOversee(actor)) redirect('/');
  const params = await searchParams;
  const range = reportRange({ from: params['from'], to: params['to'] });
  const { tasks, names } = await loadReportData(actor);
  const cohort = tasks.filter((task) => {
    const landed = Date.parse(task.landedAt);
    return landed >= range.startMs && landed < range.endMs;
  });
  const summary = summarizeDelivery(cohort.map((task) => task.timeline));
  const name = (id: string | null | undefined) => (id ? (names.get(id) ?? 'Unknown') : '');
  const creators = [...summary.creators].sort(([, a], [, b]) => b.heldHours - a.heldHours);
  const reviewers = [...summary.reviewers].sort(([, a], [, b]) => b.reviewHours - a.reviewHours);
  const openTasks = cohort.filter((task) => !task.timeline.submittedAt).toSorted((a, b) => b.timeline.totalHours - a.timeline.totalHours);
  const slowestSubmitted = cohort
    .filter((task) => task.timeline.submittedAt && !task.timeline.recovered)
    .toSorted((a, b) => b.timeline.totalHours - a.timeline.totalHours)
    .slice(0, SLOWEST_SUBMITTED);
  const maxAverage = Math.max(1, ...CLOCK_STATES.map((s) => summary.averageHoursByState[s]));
  const clockTotal = CLOCK_STATES.reduce((sum, s) => sum + summary.averageHoursByState[s], 0);
  const waitingTotal = [...QUEUE_STATES].reduce((sum, s) => sum + summary.averageHoursByState[s], 0);
  const withinShare = summary.submitted > 0 ? summary.submittedWithinTarget / summary.submitted : null;
  const firstTimeShare = summary.approvals > 0 ? summary.firstTimeApprovals / summary.approvals : null;
  const roundsPerTask = summary.reviewedTasks > 0 ? summary.reviewRounds / summary.reviewedTasks : null;
  const query = `from=${range.from}&to=${range.to}`;
  const creatorOf = (task: ReportTask) => name(task.timeline.transitions.at(-1)?.rubricHolderId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page>
      <div className="space-y-6">
        <PageHeader title="Reports">
          Tasks that landed between {range.from} and {range.to} (UTC). A task should leave the platform within {DELIVERY_TARGET_HOURS} hours of landing.
        </PageHeader>

        <div className="flex flex-wrap items-end gap-3">
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
          <nav className="flex flex-wrap gap-1.5" aria-label="Quick ranges">
            {QUICK_RANGES.map((days) => {
              const from = new Date(Date.parse(today) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
              const on = range.from === from && range.to === today;
              return (
                <Link key={days} href={`/reports?from=${from}&to=${today}`} className={`chip ${on ? 'chip-on' : ''}`} aria-current={on ? 'page' : undefined}>
                  Last {days} days
                </Link>
              );
            })}
          </nav>
        </div>

        <section className="space-y-3">
          <SectionHeading title="Speed" note={`Is work leaving the platform within ${DELIVERY_TARGET_HOURS}h?`} />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Stat
              label="Tasks in"
              value={String(summary.tasks)}
              hint={`${summary.tasks - summary.open} submitted, ${summary.open} still open`}
              detail={summary.recovered > 0 ? `${summary.recovered} restored by catch-up, timed from then` : undefined}
            />
            <Stat
              label={`Submitted within ${DELIVERY_TARGET_HOURS}h`}
              value={withinShare === null ? '—' : percent(summary.submittedWithinTarget, summary.submitted)}
              hint={`${summary.submittedWithinTarget} of ${summary.submitted} submitted tasks`}
              warn={withinShare !== null && withinShare < 0.8}
            />
            <Stat label="Typical time to submit" value={duration(summary.medianHoursToSubmit)} hint={`Half of submitted tasks took longer. Slowest 10%: ${duration(summary.p90HoursToSubmit)}`} />
            <Stat
              label={`Open past ${DELIVERY_TARGET_HOURS}h`}
              value={String(summary.openOverTarget)}
              hint={`Of ${summary.open} open tasks, listed below`}
              warn={summary.openOverTarget > 0}
            />
            <Stat
              label="Waiting for someone"
              value={percent(waitingTotal, clockTotal)}
              hint={`Of each task's time, nobody was working on it (${duration(waitingTotal)} on average)`}
              warn={clockTotal > 0 && waitingTotal / clockTotal > 0.3}
            />
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading title="Quality" note="How often work has to be redone" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Approved first time"
              value={firstTimeShare === null ? '—' : percent(summary.firstTimeApprovals, summary.approvals)}
              hint={`${summary.firstTimeApprovals} of ${summary.approvals} approvals had no send-back before them`}
              warn={firstTimeShare !== null && firstTimeShare < 0.7}
            />
            <Stat
              label="Review rounds per task"
              value={roundsPerTask === null ? '—' : roundsPerTask.toFixed(1)}
              hint={`1.0 means every task passed review on its first send. ${summary.reviewedTasks} tasks reached review`}
              warn={roundsPerTask !== null && roundsPerTask >= 1.5}
            />
            <Stat label="Sent back by review" value={String(summary.reviewReturns)} hint="Times a reviewer returned a task to its creator" warn={summary.reviewReturns > 0} />
            <Stat label="Returned by the platform" value={String(summary.platformReturns)} hint="Times a task came back after it was submitted" warn={summary.platformReturns > 0} />
          </div>
        </section>

        <section className="card">
          <SectionHeading title="Where the time goes" note="Average hours per task in each state. Orange rows are time nobody held the task." />
          <ul className="mt-4 space-y-3">
            {CLOCK_STATES.map((state) => {
              const average = summary.averageHoursByState[state];
              const queue = QUEUE_STATES.has(state);
              return (
                <li key={state} className="grid grid-cols-1 gap-1.5 text-sm md:grid-cols-[260px_1fr_150px] md:items-center md:gap-4">
                  <span>
                    <span className="block font-medium">{REPORT_STATE_LABEL[state]}</span>
                    <span className="block text-xs text-muted">{STATE_MEANING[state]}</span>
                  </span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-wash">
                    <span className={`block h-full rounded-full ${queue ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${(average / maxAverage) * 100}%` }} />
                  </span>
                  <span className="tabular-nums md:text-right">
                    {duration(average)} <span className="text-muted">({percent(average, clockTotal)} of the time)</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="px-5 pt-5">
            <SectionHeading title={`Open tasks (${openTasks.length})`} note="Still in the platform, longest first. Waiting on shows who has to act next." />
          </div>
          {openTasks.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">Every task that landed in this window has been submitted.</p>
          ) : (
            <table className="mt-3 w-full min-w-[900px] text-sm">
              <thead className="table-head">
                <tr>
                  <Th label="Task" hint="Rubric creator" />
                  <Th label="Now" />
                  <Th label="In this state" hint="Since it last moved" />
                  <Th label="In the platform" hint={`Target ${DELIVERY_TARGET_HOURS}h`} />
                  <Th label="Waiting on" />
                  <Th label="Sent back" hint="By review / by platform" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {openTasks.map((task) => {
                  const t = task.timeline;
                  const current = t.segments.at(-1)!;
                  const over = t.totalHours > DELIVERY_TARGET_HOURS;
                  return (
                    <tr key={task.id} className="hover:bg-wash">
                      <TaskCell task={task} creator={creatorOf(task)} />
                      <td className="px-5 py-3">
                        <span className={`work-pill ${PILL[current.state]}`}>{REPORT_STATE_LABEL[current.state]}</span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{duration(current.hours)}</td>
                      <td className={`px-5 py-3 tabular-nums ${over ? 'font-semibold text-warn' : ''}`}>{duration(t.totalHours)}</td>
                      <td className="px-5 py-3">{current.holderId ? name(current.holderId) : <span className="text-muted">{current.state === 'review_queue' ? 'Any reviewer' : 'Any creator'}</span>}</td>
                      <td className="px-5 py-3 tabular-nums">
                        <Returns review={t.reviewReturns} platform={t.platformReturns} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="px-5 pt-5">
            <SectionHeading title="Slowest submitted tasks" note={`The ${SLOWEST_SUBMITTED} submitted tasks that took longest, and where their time went`} />
          </div>
          {slowestSubmitted.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">No task that landed in this window has been submitted yet.</p>
          ) : (
            <table className="mt-3 w-full min-w-[900px] text-sm">
              <thead className="table-head">
                <tr>
                  <Th label="Task" hint="Rubric creator" />
                  <Th label="Time to submit" hint={`Target ${DELIVERY_TARGET_HOURS}h`} />
                  <Th label="Longest state" />
                  <Th label="Waiting for someone" hint="Nobody held it" />
                  <Th label="Review rounds" />
                  <Th label="Sent back" hint="By review / by platform" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {slowestSubmitted.map((task) => {
                  const t = task.timeline;
                  const longest = CLOCK_STATES.reduce((best, s) => (t.hoursByState[s] > t.hoursByState[best] ? s : best), CLOCK_STATES[0]!);
                  const waiting = t.hoursByState.unassigned + t.hoursByState.review_queue;
                  return (
                    <tr key={task.id} className="hover:bg-wash">
                      <TaskCell task={task} creator={creatorOf(task)} />
                      <td className={`px-5 py-3 tabular-nums ${t.totalHours > DELIVERY_TARGET_HOURS ? 'font-semibold text-warn' : ''}`}>{duration(t.totalHours)}</td>
                      <td className="px-5 py-3">
                        {REPORT_STATE_LABEL[longest]} <span className="tabular-nums text-muted">({duration(t.hoursByState[longest])})</span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{duration(waiting)}</td>
                      <td className="px-5 py-3 tabular-nums">{t.reviewRounds}</td>
                      <td className="px-5 py-3 tabular-nums">
                        <Returns review={t.reviewReturns} platform={t.platformReturns} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="px-5 pt-5">
            <SectionHeading title="Rubric creators" note="Time counts while a task sat with the creator. Click a name to download their full task history." />
          </div>
          {creators.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">No creator held a task that landed in this window.</p>
          ) : (
            <table className="mt-3 w-full min-w-[1180px] text-sm">
              <thead className="table-head">
                <tr className="border-b border-line">
                  <th className="px-5 pb-1" />
                  <GroupTh span={2}>Workload</GroupTh>
                  <GroupTh span={5}>Time with them</GroupTh>
                  <GroupTh span={4}>Quality</GroupTh>
                  <GroupTh span={1}>Output</GroupTh>
                </tr>
                <tr>
                  <Th label="Person" />
                  <Th label="Tasks" hint="Worked on" />
                  <Th label="Open now" hint={`Past ${DELIVERY_TARGET_HOURS}h`} />
                  <Th label="Total" />
                  <Th label="Per task" hint="Average" />
                  <Th label="Building" hint="Before first review" />
                  <Th label="Fixing" hint="After a send-back" />
                  <Th label="After approval" hint="Until submitted" />
                  <Th label="Sent to review" />
                  <Th label="Sent back" hint="By review" />
                  <Th label="Approved first time" hint="Of their approvals" />
                  <Th label="Returned" hint="By the platform" />
                  <Th label="Submitted" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {creators.map(([id, row]) => (
                  <tr key={id} className="hover:bg-wash">
                    <PersonCell id={id} name={name(id)} query={query} />
                    <Num>{row.tasks}</Num>
                    <td className="px-5 py-3 tabular-nums">
                      {row.openNow}
                      {row.openOverTarget > 0 ? <span className="ml-1.5 font-semibold text-warn">({row.openOverTarget})</span> : null}
                    </td>
                    <Num>{duration(row.heldHours)}</Num>
                    <Num>{duration(row.tasks > 0 ? row.heldHours / row.tasks : null)}</Num>
                    <Num>{duration(row.buildHours)}</Num>
                    <Num>{duration(row.fixHours)}</Num>
                    <Num>{duration(row.afterApprovalHours)}</Num>
                    <Num>{row.sent}</Num>
                    <Num warn={row.returnedByReview > 0}>{row.returnedByReview}</Num>
                    <td className="px-5 py-3 tabular-nums">
                      {percent(row.approvedFirstTime, row.approved)}
                      {row.approved > 0 ? <span className="ml-1.5 text-muted">({row.approvedFirstTime} of {row.approved})</span> : null}
                    </td>
                    <Num warn={row.returnedByPlatform > 0}>{row.returnedByPlatform}</Num>
                    <Num>{row.submitted}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card overflow-x-auto p-0">
          <div className="px-5 pt-5">
            <SectionHeading title="Reviewers" note="Time counts while a task sat with the reviewer. Click a name to download their full task history." />
          </div>
          {reviewers.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted">No reviewer held a task that landed in this window.</p>
          ) : (
            <table className="mt-3 w-full min-w-[960px] text-sm">
              <thead className="table-head">
                <tr className="border-b border-line">
                  <th className="px-5 pb-1" />
                  <GroupTh span={2}>Workload</GroupTh>
                  <GroupTh span={2}>Time reviewing</GroupTh>
                  <GroupTh span={4}>Decisions</GroupTh>
                </tr>
                <tr>
                  <Th label="Person" />
                  <Th label="Tasks" hint="Reviewed" />
                  <Th label="Open now" hint="In their review" />
                  <Th label="Total" />
                  <Th label="Per decision" hint="Average" />
                  <Th label="Decisions" hint="Approvals + send-backs" />
                  <Th label="Approved" />
                  <Th label="Sent back" hint="Share of decisions" />
                  <Th label="Approved, then returned" hint="By the platform" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {reviewers.map(([id, row]) => (
                  <tr key={id} className="hover:bg-wash">
                    <PersonCell id={id} name={name(id)} query={query} />
                    <Num>{row.tasks}</Num>
                    <Num>{row.openNow}</Num>
                    <Num>{duration(row.reviewHours)}</Num>
                    <Num>{duration(row.decisions > 0 ? row.reviewHours / row.decisions : null)}</Num>
                    <Num>{row.decisions}</Num>
                    <Num>{row.approved}</Num>
                    <td className="px-5 py-3 tabular-nums">
                      {row.sentBack}
                      {row.decisions > 0 ? <span className="ml-1.5 text-muted">({percent(row.sentBack, row.decisions)})</span> : null}
                    </td>
                    <Num warn={row.laterReturnedByPlatform > 0}>{row.laterReturnedByPlatform}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card space-y-4">
          <SectionHeading title="Exports" note="Excel workbooks for the same date range" />
          <div className="flex flex-wrap items-center gap-3">
            <a className="btn" href={`/api/reports/delivery?${query}`}>
              Download delivery report
            </a>
            <p className="text-sm text-muted">One row per task: hours in each state, send-backs, who worked on it and its full path.</p>
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
              Download activity report
            </button>
            <p className="text-sm text-muted">Every state change. For one person: the full history of each task they held or moved.</p>
          </form>
        </section>
      </div>
    </Page>
  );
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="section-title text-lg">{title}</h2>
      <span className="text-xs text-muted">{note}</span>
    </div>
  );
}

function Stat({ label, value, hint, detail, warn = false }: { label: string; value: string; hint: string; detail?: string; warn?: boolean }) {
  return (
    <div className={`card ${warn ? 'border-warn bg-warn-soft' : 'bg-accent-wash'}`}>
      <p className="text-sm font-medium text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold leading-8 tracking-[-0.025em] tabular-nums ${warn ? 'text-warn' : 'text-ink'}`}>{value}</p>
      <p className="mt-1 text-xs text-quiet">{hint}</p>
      {detail ? <p className="mt-1 text-xs text-quiet">{detail}</p> : null}
    </div>
  );
}

function Th({ label, hint }: { label: string; hint?: string }) {
  return (
    <th className="px-5 py-2 align-bottom">
      {label}
      {hint ? <span className="mt-0.5 block text-[11px] font-normal normal-case tracking-normal text-quiet">{hint}</span> : null}
    </th>
  );
}

function GroupTh({ span, children }: { span: number; children: ReactNode }) {
  return (
    <th colSpan={span} className="border-l border-line px-5 pb-1 pt-1 text-ink">
      {children}
    </th>
  );
}

function Num({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <td className={`px-5 py-3 tabular-nums ${warn ? 'font-semibold text-warn' : ''}`}>{children}</td>;
}

function PersonCell({ id, name, query }: { id: string; name: string; query: string }) {
  return (
    <td className="px-5 py-3 font-medium">
      <a className="hover:underline" href={`/api/reports/activity?${query}&user=${id}`} title={`Download ${name}'s task history`}>
        {name}
      </a>
    </td>
  );
}

function TaskCell({ task, creator }: { task: ReportTask; creator: string }) {
  return (
    <td className="px-5 py-3">
      <Link href={`/submissions/${task.id}`} className="font-mono font-semibold hover:underline" title={task.title || undefined}>
        {shortId(task)}
      </Link>
      <span className="mt-0.5 block text-xs text-muted">{creator || 'No creator yet'}</span>
    </td>
  );
}

function Returns({ review, platform }: { review: number; platform: number }) {
  if (review === 0 && platform === 0) return <span className="text-quiet">None</span>;
  return (
    <span className={review + platform > 1 ? 'font-semibold text-warn' : ''}>
      {review} / {platform}
    </span>
  );
}
