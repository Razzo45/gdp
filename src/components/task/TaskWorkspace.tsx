'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { statusFromView, statusKey, TASK_STATUS_PULSE_MS, type StatusPulse } from '@/domain/freshness';
import { platformReturnNote } from '@/domain/catalogReturn';
import { reviewerReturnNote } from '@/domain/review';
import { countFamilies, quotaSpread, tagStyleOf } from '@/domain/rubric';
import { stabilityReviewBlock } from '@/domain/gates';
import { staleSinceStability } from '@/domain/helper';
import type { SubmissionView } from '@/lib/services/view';
import { api } from '../client';
import { formatDate } from '../format';
import { TimeAgo } from '../TimeAgo';
import { StageBadge } from '../StageBadge';
import { ScoreStrip } from '../ScoreStrip';
import { TaskLabel } from '../TaskLabel';
import { Toast } from '../Toast';
import { Modal } from '../ui/Modal';
import { BriefPanel } from './BriefPanel';
import { EventsPanel } from './EventsPanel';
import { HandoffPanel } from './HandoffPanel';
import { JobsPanel } from './JobsPanel';
import { ReviewPanel } from './ReviewPanel';
import { RubricEditor } from './RubricEditor';
import { SeatControls, type Assignable } from './SeatControls';
import { Helper } from './Helper';
import { StabilityPanel } from './StabilityPanel';

export interface WorkspaceProps {
  initial: SubmissionView;
  actorId: string;
  assignable: Assignable[];
}

export interface PanelProps {
  view: SubmissionView;
  actorId: string;
  refresh: () => Promise<void>;
  notify: (message: string, tone?: 'ok' | 'bad') => void;
}

/**
 * The task page. Server-rendered once. Panels stay put until you act or
 * a cheap status pulse sees a stage, seat, or job-status change.
 */
export function TaskWorkspace({ initial, actorId, assignable }: WorkspaceProps) {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState(initial);
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'bad' } | null>(null);
  const [briefOpen, setBriefOpen] = useState(true);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [noteOpen, setNoteOpen] = useState(false);
  const [liveReviewPercent, setLiveReviewPercent] = useState<number | null>(initial.review.latest?.scorePercent ?? null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setReady(true);
    try {
      const stored = sessionStorage.getItem('gdp.taskBrief');
      if (stored === 'collapsed') setBriefOpen(false);
      else if (stored === 'open') setBriefOpen(true);
      else if (initial.stability && initial.stability.passes.length > 0) setBriefOpen(false);
      const header = sessionStorage.getItem('gdp.taskHeader');
      if (header === 'collapsed') setHeaderOpen(false);
      else if (header === 'open') setHeaderOpen(true);
      const note = sessionStorage.getItem('gdp.taskReturnNote');
      if (note === 'open') setNoteOpen(true);
      else if (note === 'collapsed') setNoteOpen(false);
    } catch {
      if (initial.stability && initial.stability.passes.length > 0) setBriefOpen(false);
    }
  }, [initial.stability]);

  const toggleBrief = useCallback((open: boolean) => {
    setBriefOpen(open);
    try {
      sessionStorage.setItem('gdp.taskBrief', open ? 'open' : 'collapsed');
    } catch {
      /* private mode */
    }
  }, []);

  const toggleHeader = useCallback((open: boolean) => {
    setHeaderOpen(open);
    try {
      sessionStorage.setItem('gdp.taskHeader', open ? 'open' : 'collapsed');
    } catch {
      /* private mode */
    }
  }, []);

  const toggleNote = useCallback((open: boolean) => {
    setNoteOpen(open);
    try {
      sessionStorage.setItem('gdp.taskReturnNote', open ? 'open' : 'collapsed');
    } catch {
      /* private mode */
    }
  }, []);

  const loadView = useCallback(async () => {
    setView(await api<SubmissionView>(`/api/submissions/${initial.submission.id}`));
  }, [initial.submission.id]);

  const refresh = useCallback(async () => {
    try {
      await loadView();
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not refresh.', tone: 'bad' });
    }
  }, [loadView]);

  const notify = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    setToast({ message, tone });
  }, []);

  const busy = ready && view.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    const pulse = async () => {
      try {
        const next = await api<StatusPulse>(`/api/submissions/${initial.submission.id}/pulse`);
        if (statusKey(next) !== statusKey(statusFromView(viewRef.current))) await loadView();
      } catch {
        /* keep the current view */
      }
    };
    const visible = () => document.visibilityState === 'visible';
    if (busy && visible()) void pulse();
    const handle = busy ? setInterval(() => { if (visible()) void pulse(); }, TASK_STATUS_PULSE_MS) : undefined;
    const onVisible = () => { if (visible()) void pulse(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (handle) clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [busy, initial.submission.id, loadView]);

  const s = view.submission;
  const catalogNote = platformReturnNote({ handoffStatus: s.handoffStatus, note: view.catalogReturnNote });
  const returnNote = catalogNote ?? reviewerReturnNote({ stage: s.stage, feedback: view.review.feedback });
  const returnTitle = catalogNote ? 'Catalog sent this back' : 'Reviewer sent this back';
  const panel: PanelProps = { view, actorId, refresh, notify };

  if (!ready) {
    return <div className="card text-sm text-muted">Loading the task…</div>;
  }

  return (
    <Helper.Provider view={view} refresh={refresh} notify={notify}>
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-hidden">
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}

      {returnNote && noteOpen && !headerOpen ? (
        <ReviewReturnBanner title={returnTitle} message={returnNote.message} onHide={() => toggleNote(false)} />
      ) : null}

      {headerOpen ? (
      <header className="card shrink-0 space-y-3">
        {returnNote && noteOpen ? (
          <ReviewReturnBanner flush title={returnTitle} message={returnNote.message} onHide={() => toggleNote(false)} />
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge stage={s.stage} />
              {s.handoffStatus && <span className="badge badge-muted">{s.handoffStatus.replaceAll('_', ' ')}</span>}
              {s.reviewStatus === 'changes_requested' && s.stage === 'rubric' && <span className="badge badge-warn">changes requested</span>}
            </div>
            <TaskLabel catalogId={s.catalogSubmissionId} hero={view.brief.heroDeliverable} heading />
            <p className="mt-0.5 text-xs text-muted">
              {view.brief.projectName || s.projectId}
              {view.brief.statusName ? ` · ${view.brief.statusName}` : ''}
              {view.brief.author ? ` · by ${view.brief.author}` : ''}
              {' · '}
              landed {formatDate(s.landedAt)}
              {s.lastClaimedAt ? (
                <>
                  {' · claimed '}
                  <TimeAgo iso={s.lastClaimedAt} />
                </>
              ) : null}
              {' · synced '}
              <TimeAgo iso={s.lastSeenAt} />
              {s.upstreamChangedAt && s.upstreamChangedAt > s.landedAt ? (
                <>
                  {' · upstream changed '}
                  <TimeAgo iso={s.upstreamChangedAt} />
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-start justify-end gap-2">
            {returnNote && !noteOpen ? (
              <ReturnNotePill label={catalogNote ? 'Catalog feedback' : 'Reviewer note'} onOpen={() => toggleNote(true)} />
            ) : null}
            <HeaderActions view={view} refresh={refresh} notify={notify} />
            <button className="btn btn-ghost btn-sm" type="button" aria-expanded={true} onClick={() => toggleHeader(false)}>
              Hide
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch">
          <div className="min-w-0 xl:max-w-sm">
            <SeatControls view={view} actorId={actorId} assignable={assignable} refresh={refresh} notify={notify} />
          </div>
          <ScoreStrip
            view={view}
            golden={view.can.seeScoreGolden}
            stability={view.can.seeScoreStability}
            livePercent={view.can.lens === 'reviewer' ? liveReviewPercent : undefined}
          />
        </div>
      </header>
      ) : (
      <div className="card flex shrink-0 items-center gap-3 px-3 py-2 hover:bg-wash">
        <button
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          type="button"
          aria-expanded={false}
          title="Show seats and scores"
          onClick={() => toggleHeader(true)}
        >
          <StageBadge stage={s.stage} />
          <TaskLabel catalogId={s.catalogSubmissionId} hero={view.brief.heroDeliverable} size="compact" />
          <ScoreStrip
            view={view}
            golden={view.can.seeScoreGolden}
            stability={view.can.seeScoreStability}
            livePercent={view.can.lens === 'reviewer' ? liveReviewPercent : undefined}
            compact
          />
        </button>
        <div className="ml-auto flex items-center gap-2">
          {returnNote && !noteOpen ? (
            <ReturnNotePill label={catalogNote ? 'Catalog feedback' : 'Reviewer note'} onOpen={() => toggleNote(true)} />
          ) : null}
          <button
            className="shrink-0 text-sm font-semibold text-muted"
            type="button"
            aria-expanded={false}
            onClick={() => toggleHeader(true)}
          >
            Show header
          </button>
        </div>
      </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:overflow-hidden">
        {briefOpen ? (
          <aside className="flex min-h-0 flex-col gap-3 lg:w-[22rem] lg:shrink-0 lg:overflow-y-auto lg:pr-1 xl:w-[26rem]">
            <BriefPanel {...panel} onHide={() => toggleBrief(false)} />
            {view.can.seeJobsLog ? <JobsPanel {...panel} /> : view.can.seeRunProgress ? <JobsPanel {...panel} mode="live" /> : null}
            {view.can.seeHistory && <EventsPanel {...panel} />}
          </aside>
        ) : (
          <button
            className="flex shrink-0 self-start items-center justify-center rounded-3xl border border-line bg-surface px-2 text-sm font-semibold text-muted hover:bg-wash hover:text-ink lg:self-stretch"
            type="button"
            aria-expanded={false}
            title="Show task brief"
            onClick={() => toggleBrief(true)}
          >
            <span className="py-2 tracking-wide lg:[writing-mode:vertical-rl] lg:rotate-180 lg:py-3">Task brief</span>
          </button>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-y-auto">
          {view.can.seeRubricEditor && (view.rubric || view.can.editRubric) && <RubricEditor {...panel} />}
          {view.can.seeStability && <StabilityPanel {...panel} />}
          {view.can.seeReviewPanel &&
            (s.stage === 'review' || view.review.submittedPercent !== null || view.review.feedback.length > 0 || view.can.review) && (
              <ReviewPanel {...panel} onLiveScore={view.can.lens === 'reviewer' ? setLiveReviewPercent : undefined} />
            )}
          {view.can.seeHandoff && (s.stage === 'handoff' || s.stage === 'done' || s.handoffStatus) && <HandoffPanel {...panel} />}
          {s.stage === 'done' && (
            <p className="card text-sm text-muted">
              Delivered to the Catalog {formatDate(s.pushedAt)}. <Link className="underline" href="/submissions">Back to tasks</Link>.
            </p>
          )}
        </div>
      </div>
      {view.can.seeRubricEditor ? (
        <>
          <Helper.Launcher />
          <Helper.Panel />
        </>
      ) : null}
    </div>
    </Helper.Provider>
  );
}

function ReturnNotePill({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      className="inline-flex h-8 shrink-0 items-center rounded-full border border-warn bg-warn-soft px-3 text-[13px] font-semibold text-warn hover:bg-warn-soft"
      type="button"
      aria-expanded={false}
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

function ReviewReturnBanner({
  title,
  message,
  flush = false,
  onHide,
}: {
  title: string;
  message: string;
  flush?: boolean;
  onHide: () => void;
}) {
  return (
    <aside
      className={
        flush
          ? '-mx-5 -mt-5 rounded-t-[1.4rem] border-b-2 border-warn bg-warn-soft px-5 py-4'
          : 'shrink-0 rounded-3xl border-2 border-warn bg-warn-soft px-5 py-4'
      }
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-bold text-warn">{title}</p>
        <button className="btn btn-ghost btn-sm shrink-0" type="button" aria-expanded={true} onClick={onHide}>
          Hide
        </button>
      </div>
      <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{message}</p>
    </aside>
  );
}

function HeaderActions({ view, refresh, notify }: Pick<PanelProps, 'view' | 'refresh' | 'notify'>) {
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const s = view.submission;
  const statements = view.rubric?.statements ?? [];
  const style = tagStyleOf({ tags: statements.map((row) => row.tag), hasCurrentRubric: Boolean(view.rubric) });
  const spread = quotaSpread(countFamilies(statements), undefined, style);
  const goldenStale = statements.filter((row) => view.golden?.sources[row.id] === 'stale').length;
  const passes = view.stability?.passes ?? [];
  const stabilityBlock = stabilityReviewBlock({
    passes: passes.length,
    complete: view.stability?.gate?.complete === true,
    inBand: view.stability?.gate?.inBand === true,
    stale: staleSinceStability(statements, passes),
  });
  const canSend = view.can.editRubric && view.golden?.gate.ok && !stabilityBlock && view.aiOutputs.length > 0 && spread.ready;
  const showSend = view.can.editRubric && s.stage === 'rubric';
  const showPush = view.can.push;
  const showOpenRubric = view.can.openRubric;
  const showOpenStability = view.can.openStability;

  if (!showSend && !showPush && !showOpenRubric && !showOpenStability) return null;

  async function send() {
    setBusy(true);
    try {
      await api(`/api/submissions/${s.id}/review/send`, { body: {} });
      notify(s.reviewStatus === 'changes_requested' ? 'Sent to Review Again.' : 'Sent to the Review Team.');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not send to review.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function open(target: 'rubric' | 'stability') {
    setBusy(true);
    try {
      await api(`/api/submissions/${s.id}/return/open`, { body: { target } });
      notify(target === 'rubric' ? 'The rubric is open.' : 'Stability is open. Run it, then accept the result.');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open that stage.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    setBusy(true);
    try {
      const result = await api<{ rubricItems: number; moves: string[] }>(`/api/submissions/${s.id}/handoff/push`, { method: 'POST' });
      setConfirmPush(false);
      notify(`Submitted to the Data Catalog. ${result.rubricItems} rubric rows · ${result.moves.length} workflow move(s).`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Push failed.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const blocked =
    showSend && !canSend
      ? !spread.ready
        ? spread.warning
        : !view.golden?.gate.ok
          ? goldenStale > 0
            ? `Re-grade the golden file: ${goldenStale} seat${goldenStale === 1 ? '' : 's'} changed since it was graded.`
            : 'Golden must be 100% first.'
          : stabilityBlock ?? 'Attach the AI output first.'
      : null;

  return (
    <div className="flex max-w-xs flex-col items-stretch gap-1.5 sm:items-end">
      {showOpenRubric && (
        <button className="btn" disabled={busy} type="button" onClick={() => void open('rubric')}>
          Open rubric
        </button>
      )}
      {showOpenStability && (
        <button className="btn" disabled={busy} type="button" onClick={() => void open('stability')}>
          Open stability
        </button>
      )}
      {showSend && (
        <>
          <button className="btn btn-primary" disabled={busy || !canSend} type="button" onClick={() => void send()}>
            {busy ? 'Sending…' : s.reviewStatus === 'changes_requested' ? 'Send to review again' : 'Send to review'}
          </button>
          {blocked && <p className="text-right text-xs text-muted">{blocked}</p>}
        </>
      )}
      {showPush && (
        <button className="btn btn-primary" disabled={busy} type="button" onClick={() => setConfirmPush(true)}>
          Submit to Data Program
        </button>
      )}
      {confirmPush && (
        <Modal title="Submit to Data Program" onClose={() => setConfirmPush(false)}>
          <p className="text-sm text-muted">Write the rubric and performance summary into the Catalog and move the submission to the handoff status. This cannot be undone here.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy} type="button" onClick={() => void push()}>
              {busy ? 'Submitting…' : 'Submit to Data Program'}
            </button>
            <button className="btn" type="button" onClick={() => setConfirmPush(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
