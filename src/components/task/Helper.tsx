'use client';

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { helperGate, promptFromFields, staleSinceStability } from '@/domain/helper';
import { projectPicked, swapUpserts, type RetireReason, type TightenReport, type TightenSwap } from '@/domain/tighten';
import type { SubmissionView } from '@/lib/services/view';
import { api } from '../client';
import type { PanelProps } from './TaskWorkspace';

interface HelperState {
  open: boolean;
  running: boolean;
  applying: boolean;
  picked: ReadonlySet<string>;
}

interface HelperActions {
  openPanel: () => void;
  closePanel: () => void;
  run: () => Promise<void>;
  toggle: (seatId: string) => void;
  apply: () => Promise<void>;
  jump: (seatId: string) => void;
}

interface HelperMeta {
  missing: string[];
  live: boolean;
  autorateLocked: boolean;
  canRun: boolean;
  canApply: boolean;
  result: TightenReport | null;
  /** Seats edited since the helper looked; their swaps are not offered. */
  stale: ReadonlySet<string>;
  projected: number[];
  note: string | null;
  error: string | null;
}

const HelperContext = createContext<{ state: HelperState; actions: HelperActions; meta: HelperMeta } | null>(null);

function missingOf(view: SubmissionView): string[] {
  const prompt = promptFromFields(view.brief.fields);
  return helperGate({
    hasRubric: (view.rubric?.statements.length ?? 0) > 0,
    goldenGraded: view.rubric?.statements.filter((row) => view.golden?.verdicts[row.id] === true || view.golden?.verdicts[row.id] === false).length ?? 0,
    stabilityPasses: view.stability?.passes.length ?? 0,
    hasAi: view.aiOutputs.length > 0,
    hasPrompt: prompt.trim().length > 0,
    goldenStale: view.rubric?.statements.filter((row) => view.golden?.sources[row.id] === 'stale').length ?? 0,
    stabilityStale: staleSinceStability(view.rubric?.statements ?? [], view.stability?.passes ?? []),
  }).missing;
}

function HelperProvider({ view, refresh, notify, children }: Pick<PanelProps, 'view' | 'refresh' | 'notify'> & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [unpicked, setUnpicked] = useState<{ job: string | null; ids: Set<string> }>({ job: null, ids: new Set() });
  const missing = missingOf(view);
  const live = view.helper?.status === 'queued' || view.helper?.status === 'running' || view.jobs.some((job) => job.kind === 'rubric_helper' && (job.status === 'queued' || job.status === 'running'));
  const autorateLocked = view.jobs.some((job) => job.kind === 'golden_autorate' && (job.status === 'queued' || job.status === 'running'));
  const canRun = view.can.editRubric && missing.length === 0 && !live && !autorateLocked && !running;
  const result = live ? null : (view.helper?.result ?? null);
  const note = view.helper?.progress.note ?? (live ? 'Waiting behind other work…' : null);
  const error = view.helper?.error ?? null;
  const jobId = view.helper?.id ?? null;
  const statements = view.rubric?.statements;

  const stale = useMemo(() => {
    const current = new Map((statements ?? []).map((row) => [row.id, row.statement]));
    return new Set((result?.swaps ?? []).filter((swap) => current.get(swap.seatId) !== swap.seatStatement).map((swap) => swap.seatId));
  }, [result, statements]);
  const picked = useMemo(() => {
    const skip = unpicked.job === jobId ? unpicked.ids : new Set<string>();
    return new Set((result?.swaps ?? []).filter((swap) => !skip.has(swap.seatId) && !stale.has(swap.seatId)).map((swap) => swap.seatId));
  }, [jobId, result, stale, unpicked]);
  const projected = useMemo(() => (result ? projectPicked(result, picked) : []), [picked, result]);
  const canApply = view.can.editRubric && picked.size > 0 && !applying && !live;

  const run = useCallback(async () => {
    setRunning(true);
    setOpen(true);
    try {
      await api(`/api/submissions/${view.submission.id}/helper`, { body: { requestId: crypto.randomUUID() } });
      notify('Looking for swaps. This takes a few minutes and waits if other work is running.');
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not start the helper.', 'bad');
    } finally {
      setRunning(false);
    }
  }, [notify, refresh, view.submission.id]);

  const toggle = useCallback(
    (seatId: string) => {
      setUnpicked((current) => {
        const ids = new Set(current.job === jobId ? current.ids : []);
        if (ids.has(seatId)) ids.delete(seatId);
        else ids.add(seatId);
        return { job: jobId, ids };
      });
    },
    [jobId],
  );

  const apply = useCallback(async () => {
    if (!result || !view.rubric) return;
    const { upserts, stale: skipped } = swapUpserts(result.swaps, picked, view.rubric.statements);
    if (upserts.length === 0) return;
    setApplying(true);
    try {
      await api(`/api/submissions/${view.submission.id}/rubric`, { method: 'PUT', body: { revision: view.rubric.revision, upserts, deletes: [] } });
      notify(`Swapped ${upserts.length} seat${upserts.length === 1 ? '' : 's'}${skipped.length ? `; skipped ${skipped.length} edited since` : ''}. Grade the golden file and run Stability to confirm.`);
      setUnpicked({ job: jobId, ids: new Set(result.swaps.map((swap) => swap.seatId)) });
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not apply the swaps.', 'bad');
      await refresh();
    } finally {
      setApplying(false);
    }
  }, [jobId, notify, picked, refresh, result, view.rubric, view.submission.id]);

  const jump = useCallback((seatId: string) => {
    setOpen(false);
    const node = document.getElementById(`rubric-statement-${seatId}`);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (node instanceof HTMLElement) node.focus();
  }, []);

  const value = useMemo(
    () => ({
      state: { open, running, applying, picked },
      actions: { openPanel: () => setOpen(true), closePanel: () => setOpen(false), run, toggle, apply, jump },
      meta: { missing, live, autorateLocked, canRun, canApply, result, stale, projected, note, error },
    }),
    [apply, applying, autorateLocked, canApply, canRun, error, jump, live, missing, note, open, picked, projected, result, run, running, stale, toggle],
  );

  return <HelperContext value={value}>{children}</HelperContext>;
}

function useHelper() {
  const value = use(HelperContext);
  if (!value) throw new Error('Helper is missing its provider.');
  return value;
}

function HelperLauncher() {
  const {
    state,
    actions,
    meta: { live },
  } = useHelper();
  const busy = state.running || live;
  return (
    <div className="pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-40">
      <button
        className="pointer-events-auto flex h-14 w-14 touch-manipulation items-center justify-center rounded-full bg-accent text-white shadow-[0_10px_28px_-12px_rgb(99_117_255_/_0.9)] transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        type="button"
        aria-expanded={state.open}
        aria-controls="helper-panel"
        aria-label={state.open ? 'Close Get under 50%' : 'Get under 50%'}
        title={state.open ? 'Close' : 'Get under 50%'}
        onClick={() => (state.open ? actions.closePanel() : actions.openPanel())}
      >
        {busy ? (
          <span className="motion-safe:animate-spin">
            <BusyMark />
          </span>
        ) : state.open ? (
          <CloseMark />
        ) : (
          <HandMark />
        )}
      </button>
    </div>
  );
}

function HelperPanel() {
  const { state, actions, meta } = useHelper();
  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') actions.closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, state.open]);
  if (!state.open) return null;
  const busy = state.running || meta.live;
  const result = meta.result;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40" role="dialog" aria-modal="true" aria-labelledby="helper-title">
      <button className="h-full flex-1 cursor-default" type="button" aria-label="Close Get under 50%" onClick={actions.closePanel} />
      <aside id="helper-panel" className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-line bg-surface shadow-lg overscroll-contain">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="helper-title" className="text-pretty text-base font-semibold">
              Get under 50%
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Finds what the brief, acceptance criteria or inputs ask for that the AI output misses. Every lock cites the line it comes from and is graded on the golden file and the AI output before it is offered.
              Nothing changes until you apply.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" type="button" onClick={actions.closePanel}>
            Close
          </button>
        </header>
        <div className="flex shrink-0 flex-col gap-3 border-b border-line px-5 py-3">
          <button className="btn btn-primary self-start" disabled={!meta.canRun || state.running} type="button" onClick={() => void actions.run()}>
            {busy ? 'Looking…' : result ? 'Look again' : 'Find swaps'}
          </button>
          {result ? <Scores result={result} projected={meta.projected} /> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {meta.missing.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
              {meta.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          ) : null}
          {meta.autorateLocked ? <p className="text-sm text-muted">Golden grading is still running. We will wait.</p> : null}
          {busy ? (
            <p className="text-sm text-muted" aria-live="polite">
              {meta.note ?? 'Looking…'}
            </p>
          ) : null}
          {meta.error ? <p className="text-sm text-bad">{meta.error}</p> : null}
          {result ? (
            <SwapList result={result} />
          ) : !busy && meta.missing.length === 0 ? (
            <p className="text-sm leading-6 text-muted">Grade the golden file and run Stability, then find swaps.</p>
          ) : null}
        </div>
        {result && result.swaps.length > 0 ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-sm text-muted">
              <span className="tabular-nums">{state.picked.size}</span> of <span className="tabular-nums">{result.swaps.length}</span> ticked
            </p>
            <button className="btn btn-primary" disabled={!meta.canApply} type="button" onClick={() => void actions.apply()}>
              {state.applying ? 'Applying…' : `Apply ${state.picked.size} swap${state.picked.size === 1 ? '' : 's'}`}
            </button>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

function passes(values: readonly number[]): string {
  return values.map((value) => `${value}%`).join(' · ');
}

function Scores({ result, projected }: { result: TightenReport; projected: number[] }) {
  const ok = projected.length > 0 && projected.every((value) => value <= 50);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="text-xs text-muted">AI output now</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{passes(result.before)}</p>
      </div>
      <div>
        <p className="text-xs text-muted">With the ticked swaps</p>
        <p className={`mt-0.5 text-lg font-semibold tabular-nums ${ok ? 'text-ink' : 'text-bad'}`}>{passes(projected)}</p>
        <p className="text-xs text-muted">Every pass must be 50% or lower. We aim for {result.target}%.</p>
      </div>
    </div>
  );
}

function SwapList({ result }: { result: TightenReport }) {
  const { state, actions, meta } = useHelper();
  return (
    <div className="space-y-6">
      {result.stoppedEarly ? <p className="text-sm leading-6 text-muted">The search stopped early ({result.stoppedEarly}). These swaps were all checked before it stopped.</p> : null}
      {result.reached ? null : (
        <p className="text-sm leading-6 text-bad">
          {result.swaps.length ? 'These swaps are not enough on their own. ' : ''}
          We could not find enough grounded locks the AI output fails: {result.shortBy} more seat{result.shortBy === 1 ? '' : 's'} need to flip on the worst pass. Look again, or write locks from the brief by hand.
        </p>
      )}
      {result.reached && result.swaps.length === 0 ? <p className="text-sm text-muted">The AI output is already under the target. Nothing to swap.</p> : null}
      {result.swaps.length > 0 && !result.quotaReady ? <p className="text-sm text-bad">Applying every swap leaves the family mix outside the quota.</p> : null}
      {result.swaps.map((swap) => (
        <SwapCard key={swap.seatId} swap={swap} picked={state.picked.has(swap.seatId)} stale={meta.stale.has(swap.seatId)} onToggle={actions.toggle} onJump={actions.jump} />
      ))}
      <CoreSeats result={result} />
      <NotOffered result={result} />
    </div>
  );
}

const REASON: Record<RetireReason, string> = {
  false_on_golden: 'The golden file fails this seat',
  duplicate: 'Says the same as another seat',
  flips: 'Graded differently between passes',
  passes_both: 'The AI output passes it',
};

function SwapCard({ swap, picked, stale, onToggle, onJump }: { swap: TightenSwap; picked: boolean; stale: boolean; onToggle: (seatId: string) => void; onJump: (seatId: string) => void }) {
  const { lock } = swap;
  const id = `swap-${swap.seatId}`;
  return (
    <article className={`rounded-2xl border px-4 py-3 ${picked ? 'border-accent bg-wash' : 'border-line'} ${stale ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <input id={id} className="mt-1 h-4 w-4 shrink-0 accent-accent" type="checkbox" checked={picked} disabled={stale} onChange={() => onToggle(swap.seatId)} />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <p className="text-xs font-medium text-muted">
            Replace · {REASON[swap.reason]}
          </p>
          <p className="mt-1 text-sm leading-6 break-words text-muted line-through decoration-zinc-400">{swap.seatStatement}</p>
          <p className="mt-3 text-xs font-medium text-muted">With · {lock.tag}</p>
          <p className="mt-1 text-sm leading-6 break-words text-ink">{lock.statement}</p>
        </label>
      </div>
      <div className="mt-3 ml-7 space-y-2">
        <p className="text-xs text-muted">
          <span className="font-medium text-ink">{lock.basis === 'verbatim' ? 'Word for word' : 'Interpretation'}</span> of {lock.sourceLabel}
        </p>
        <blockquote className="border-l-2 border-line pl-3 text-sm leading-6 break-words text-ink">“{lock.quote}”</blockquote>
        <p className="text-sm leading-6 text-muted">{lock.rationale}</p>
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted">What the grader saw</summary>
          <p className="mt-2 leading-6 text-muted">
            <span className="font-medium text-ink">Golden file passes.</span> {lock.goldenEvidence}
          </p>
          <p className="mt-2 leading-6 text-muted">
            <span className="font-medium text-ink">AI output fails on all {lock.ai.length} passes.</span> {lock.aiEvidence[0]}
          </p>
        </details>
        {stale ? <p className="text-xs text-bad">This seat was edited since. Look again to get a fresh swap.</p> : null}
        <button className="btn btn-sm btn-ghost" type="button" onClick={() => onJump(swap.seatId)}>
          Go to seat
        </button>
      </div>
    </article>
  );
}

function NotOffered({ result }: { result: TightenReport }) {
  const count = result.guarded.length + result.rejected.length;
  if (count === 0) return null;
  return (
    <details className="rounded-2xl border border-line px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Not offered <span className="ml-1 tabular-nums text-muted">{count}</span>
      </summary>
      <ul className="mt-3 space-y-3">
        {result.rejected.map((row) => (
          <li key={row.id}>
            <p className="leading-6 break-words text-ink">{row.statement}</p>
            <p className="text-xs text-muted">{row.why}</p>
          </li>
        ))}
        {result.guarded.map((row) => (
          <li key={row.statement}>
            <p className="leading-6 break-words text-ink">{row.statement}</p>
            <p className="text-xs text-muted">{row.reasons.join(' ')}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function CoreSeats({ result }: { result: TightenReport }) {
  if (!result.core?.length) return null;
  return (
    <details className="rounded-2xl border border-line px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Kept as core <span className="ml-1 tabular-nums text-muted">{result.core.length}</span>
      </summary>
      <p className="mt-2 text-xs text-muted">These check what the brief explicitly asks for, so they are only swapped when the golden file fails them.</p>
      <ul className="mt-3 space-y-2">
        {result.core.map((statement) => (
          <li key={statement} className="leading-6 break-words text-ink">
            {statement}
          </li>
        ))}
      </ul>
    </details>
  );
}

function HandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        d="M8.2 12.2V6.4a1.2 1.2 0 0 1 2.4 0v4.6M10.6 10.8V5.3a1.2 1.2 0 1 1 2.4 0v5.7M13 10.4V6.6a1.2 1.2 0 1 1 2.4 0v6.1M15.4 12.2V8.8a1.2 1.2 0 1 1 2.4 0v6.2c0 3.1-2.3 5.3-5.6 5.3-2.2 0-3.9-.8-5.2-2.4L6.2 15a1.6 1.6 0 0 1 .2-2.2 1.6 1.6 0 0 1 1.8-.2l1.2.6"
      />
    </svg>
  );
}

function CloseMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" d="M7 7l10 10M17 7 7 17" />
    </svg>
  );
}

function BusyMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" d="M12 4.2a7.8 7.8 0 1 1-5.5 2.3" opacity="0.35" />
      <path stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" d="M12 4.2a7.8 7.8 0 0 1 6.4 3.4" />
    </svg>
  );
}

export const Helper = {
  Provider: HelperProvider,
  Launcher: HelperLauncher,
  Panel: HelperPanel,
};
