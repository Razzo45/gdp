'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { statusFromView, statusKey, TASK_STATUS_PULSE_MS, type StatusPulse } from '@/domain/freshness';
import type { SubmissionView } from '@/lib/services/view';
import { api } from '../client';
import { formatDate } from '../format';
import { TimeAgo } from '../TimeAgo';
import { StageBadge } from '../StageBadge';
import { ScoreStrip } from '../ScoreStrip';
import { Toast } from '../Toast';
import { BriefPanel } from './BriefPanel';
import { EventsPanel } from './EventsPanel';
import { HandoffPanel } from './HandoffPanel';
import { JobsPanel } from './JobsPanel';
import { ReviewPanel } from './ReviewPanel';
import { RubricEditor } from './RubricEditor';
import { SeatControls, type Assignable } from './SeatControls';
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
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setReady(true);
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
    const handle = busy ? setInterval(() => { if (visible()) void pulse(); }, TASK_STATUS_PULSE_MS) : undefined;
    const onVisible = () => { if (visible()) void pulse(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (handle) clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [busy, initial.submission.id, loadView]);

  const s = view.submission;
  const panel: PanelProps = { view, actorId, refresh, notify };

  if (!ready) {
    return <div className="card text-sm text-muted">Loading the task…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-hidden">
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}

      <header className="card shrink-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge stage={s.stage} />
              {s.handoffStatus && <span className="badge badge-muted">{s.handoffStatus.replaceAll('_', ' ')}</span>}
              {s.reviewStatus === 'changes_requested' && s.stage === 'rubric' && <span className="badge badge-warn">changes requested</span>}
            </div>
            <h1 className="section-title mt-1">{s.title || s.catalogSubmissionId}</h1>
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
          <HeaderActions view={view} refresh={refresh} notify={notify} />
        </div>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch">
          <div className="min-w-0 xl:max-w-sm">
            <SeatControls view={view} actorId={actorId} assignable={assignable} refresh={refresh} notify={notify} />
          </div>
          <ScoreStrip
            view={view}
            golden={view.can.seeScoreGolden}
            human
            stability={view.can.seeScoreStability}
          />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1">
          <BriefPanel {...panel} />
          {view.can.seeJobsLog ? <JobsPanel {...panel} /> : view.can.seeRunProgress ? <JobsPanel {...panel} mode="live" /> : null}
          {view.can.seeHistory && <EventsPanel {...panel} />}
        </div>
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
          {view.can.seeRubricEditor && (view.rubric || view.can.editRubric) && <RubricEditor {...panel} />}
          {view.can.seeReviewPanel &&
            (s.stage === 'review' || view.review.submittedPercent !== null || view.review.feedback.length > 0 || view.can.review) && <ReviewPanel {...panel} />}
          {view.can.seeStability &&
            (view.can.runStability || s.stage === 'handoff' || (view.stability && view.stability.passes.length > 0)) && <StabilityPanel {...panel} />}
          {view.can.seeHandoff && (s.stage === 'handoff' || s.stage === 'done' || s.handoffStatus) && <HandoffPanel {...panel} />}
          {s.stage === 'done' && (
            <p className="card text-sm text-muted">
              Delivered to the Catalog {formatDate(s.pushedAt)}. <Link className="underline" href="/submissions">Back to tasks</Link>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderActions({ view, refresh, notify }: Pick<PanelProps, 'view' | 'refresh' | 'notify'>) {
  const [busy, setBusy] = useState(false);
  const s = view.submission;
  const canSend = view.can.editRubric && view.golden?.gate.ok && view.aiOutputs.length > 0;
  const showSend = view.can.editRubric && s.stage === 'rubric';
  const showSubmit = view.can.push;

  if (!showSend && !showSubmit) return null;

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

  const blocked = showSend && !canSend ? (!view.golden?.gate.ok ? 'Golden must be 100% first.' : 'Attach the AI output first.') : null;

  return (
    <div className="flex max-w-xs flex-col items-stretch gap-1.5 sm:items-end">
      {showSend && (
        <>
          <button className="btn btn-primary" disabled={busy || !canSend} type="button" onClick={() => void send()}>
            {busy ? 'Sending…' : s.reviewStatus === 'changes_requested' ? 'Send to review again' : 'Send to review'}
          </button>
          {blocked && <p className="text-right text-xs text-muted">{blocked}</p>}
        </>
      )}
      {showSubmit && (
        <a className="btn btn-primary" href="#handoff">
          Go to submit
        </a>
      )}
    </div>
  );
}
