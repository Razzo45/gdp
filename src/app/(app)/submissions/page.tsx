import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BoardFreshness } from '@/components/BoardFreshness';
import { CatalogReturnQueue } from '@/components/CatalogReturnQueue';
import { ImportTask } from '@/components/ImportTask';
import { ModelTagChips } from '@/components/ModelTagChips';
import { ModelTagPill } from '@/components/ModelTagPill';
import { Page } from '@/components/Page';
import { PageHeader } from '@/components/PageHeader';
import { currentActor } from '@/lib/auth/identity';
import { canOversee, isController } from '@/lib/auth/permissions';
import { listPendingCatalogReturns } from '@/lib/services/catalogReturn';
import { listSubmissions } from '@/lib/services/submissions';
import { CollapsibleCopy, TaskLabel } from '@/components/TaskLabel';
import { TimeAgo } from '@/components/TimeAgo';
import { WorkStateChips } from '@/components/WorkStateChips';
import { WorkStatusPill } from '@/components/WorkStatusPill';
import { isModelTag, MODEL_TAGS, type ModelTag } from '@/domain/modelTag';
import { BOARD_STATES, boardListRows, WORK_STATE_HINT, WORK_STATE_LABEL, WORK_STATES, type WorkState } from '@/domain/workState';

export const dynamic = 'force-dynamic';

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const params = await searchParams;
  const workState = WORK_STATES.includes(params['state'] as WorkState) ? (params['state'] as WorkState) : undefined;
  const modelTag = isModelTag(params['model']) ? params['model'] : undefined;
  const q = params['q']?.trim() || undefined;
  const mine = params['mine'] === '1';
  const operate = isController(actor);
  const oversee = canOversee(actor);
  const [listedQuery, pendingReturns] = await Promise.all([
    listSubmissions(actor, { mine, q, modelTag }),
    oversee ? listPendingCatalogReturns(actor) : Promise.resolve([]),
  ]);
  const scoped = oversee ? listedQuery : listedQuery.filter((r) => !r.blinded);
  const listed = boardListRows(scoped, { workState, q });
  const countRows = q ? await listSubmissions(actor, { mine, modelTag }) : listedQuery;
  const counts = Object.fromEntries(BOARD_STATES.map((s) => [s, countRows.filter((r) => r.workState === s).length])) as Record<WorkState, number>;
  const modelCountSource = q || modelTag ? await listSubmissions(actor, { mine }) : listedQuery;
  const modelCounts = Object.fromEntries(MODEL_TAGS.map((tag) => [tag, modelCountSource.filter((r) => r.modelTag === tag).length])) as Record<
    ModelTag,
    number
  >;
  const evidenceColumn =
    workState === 'submitted' ? 'Evidence' : listed.some((row) => row.workState === 'submitted') ? 'Evidence / activity' : 'Last interaction';

  const allHref = (() => {
    const next = new URLSearchParams();
    if (modelTag) next.set('model', modelTag);
    const query = next.toString();
    return query ? `/submissions?${query}` : '/submissions';
  })();
  const mineHref = (() => {
    const next = new URLSearchParams({ mine: '1' });
    if (modelTag) next.set('model', modelTag);
    return `/submissions?${next.toString()}`;
  })();

  return (
    <Page>
    <BoardFreshness />
    <div className="space-y-5">
      <PageHeader
        title="Submissions"
        actions={
          oversee ? (
            <>
              <Link href={allHref} className={`chip ${!mine && (q || !workState) ? 'chip-on' : ''}`}>
                All
              </Link>
              <Link href={mineHref} className={`chip ${mine ? 'chip-on' : ''}`}>
                Mine
              </Link>
            </>
          ) : undefined
        }
      >
        {q
          ? 'Search looks across every panel. Work status says where each match sits.'
          : workState
            ? WORK_STATE_HINT[workState]
            : oversee
              ? 'This project’s board. Claim and personal status live on the dashboard when more projects land.'
              : 'This project’s tasks you already hold. Claim from the dashboard.'}
      </PageHeader>

      {oversee && <ModelTagChips counts={modelCounts} active={modelTag} workState={workState} mine={mine} />}
      {oversee && <WorkStateChips counts={counts} active={q ? undefined : workState} modelTag={modelTag} mine={mine} />}

      {oversee && (
        <form className="flex flex-wrap items-end gap-2" action="/submissions" method="get">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
            Full or partial submission ID
            <input className="input" name="q" defaultValue={q ?? ''} placeholder="Catalog submission id or title" />
          </label>
          {modelTag ? <input type="hidden" name="model" value={modelTag} /> : null}
          {mine ? <input type="hidden" name="mine" value="1" /> : null}
          <button className="btn" type="submit">
            Search
          </button>
          {q && (
            <Link href={allHref} className="btn">
              Clear
            </Link>
          )}
        </form>
      )}

      {oversee && <CatalogReturnQueue items={pendingReturns} readOnly={!operate} />}
      {operate && <ImportTask />}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="sticky top-0 bg-wash text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            <tr>
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Work status</th>
              <th className="px-4 py-3">Assigned to</th>
              <th className="px-4 py-3">{evidenceColumn}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {listed.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
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
                    <TaskLabel catalogId={s.catalogSubmissionId} hero={s.heroDeliverable} />
                    {s.catalogReturnNote ? (
                      <p className="mt-1 text-xs leading-[18px] text-muted">
                        Why: <CollapsibleCopy text={s.catalogReturnNote} />
                      </p>
                    ) : null}
                  </Link>
                </td>
                <td className="px-4 py-3.5 align-middle">
                  <ModelTagPill tag={s.modelTag} size="board" />
                </td>
                <td className="px-4 py-3.5 align-middle">
                  <WorkStatusPill state={s.workState} size="board" />
                </td>
                <td className="px-4 py-3.5 align-middle">
                  {assignee ? <span className="text-sm font-semibold leading-[22px]">{assignee}</span> : <span className="text-quiet">—</span>}
                </td>
                <td className="px-4 py-3.5 align-middle text-xs leading-[18px] text-muted">
                  {s.workState === 'submitted' ? (
                    <a
                      className="btn btn-ghost btn-sm relative z-10"
                      href={`/api/submissions/${s.id}/rubric/evidence`}
                    >
                      Evidence JSON
                    </a>
                  ) : s.lastInteractionAt ? (
                    <TimeAgo iso={s.lastInteractionAt} />
                  ) : (
                    <span className="text-quiet">—</span>
                  )}
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
