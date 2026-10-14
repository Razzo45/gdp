'use client';

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { helperGate, promptFromFields, type HelperActRow, type HelperAnalysisRow, type HelperPackedRow, type HelperResult } from '@/domain/helper';
import type { SubmissionView } from '@/lib/services/view';
import { api } from '../client';
import type { PanelProps } from './TaskWorkspace';

interface HelperState {
  open: boolean;
  running: boolean;
}

interface HelperActions {
  openPanel: () => void;
  closePanel: () => void;
  run: () => Promise<void>;
  copy: (statement: string) => Promise<void>;
  jump: (seatId: string) => void;
}

interface HelperMeta {
  missing: string[];
  live: boolean;
  autorateLocked: boolean;
  canRun: boolean;
  result: HelperResult | null;
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
  }).missing;
}

function HelperProvider({ view, refresh, notify, children }: Pick<PanelProps, 'view' | 'refresh' | 'notify'> & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const missing = missingOf(view);
  const live = view.helper?.status === 'queued' || view.helper?.status === 'running' || view.jobs.some((job) => job.kind === 'rubric_helper' && (job.status === 'queued' || job.status === 'running'));
  const autorateLocked = view.jobs.some((job) => job.kind === 'golden_autorate' && (job.status === 'queued' || job.status === 'running'));
  const canRun = view.can.editRubric && missing.length === 0 && !live && !autorateLocked && !running;
  const result = view.helper?.result ?? null;
  const note = view.helper?.progress.note ?? (live ? 'Waiting behind other work…' : null);
  const error = view.helper?.error ?? null;

  const run = useCallback(async () => {
    setRunning(true);
    setOpen(true);
    try {
      await api(`/api/submissions/${view.submission.id}/helper`, { body: { requestId: crypto.randomUUID() } });
      notify('Looking at your seats. This waits if other work is running.');
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not start Need a hand.', 'bad');
    } finally {
      setRunning(false);
    }
  }, [notify, refresh, view.submission.id]);

  const copy = useCallback(
    async (statement: string) => {
      try {
        await navigator.clipboard.writeText(statement);
        notify('Copied. Paste it into the seat when you want it.');
      } catch {
        notify('Could not copy.', 'bad');
      }
    },
    [notify],
  );

  const jump = useCallback((seatId: string) => {
    setOpen(false);
    const node = document.getElementById(`rubric-statement-${seatId}`);
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (node instanceof HTMLElement) node.focus();
  }, []);

  const value = useMemo(
    () => ({
      state: { open, running },
      actions: { openPanel: () => setOpen(true), closePanel: () => setOpen(false), run, copy, jump },
      meta: { missing, live, autorateLocked, canRun, result, note, error },
    }),
    [autorateLocked, canRun, copy, error, jump, live, missing, note, open, result, run, running],
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
    meta: { live, canRun },
  } = useHelper();
  const busy = state.running || live;
  return (
    <div className="pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-40">
      <button
        className="pointer-events-auto flex h-14 w-14 touch-manipulation items-center justify-center rounded-full bg-accent text-white shadow-[0_10px_28px_-12px_rgb(99_117_255_/_0.9)] transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        type="button"
        aria-expanded={state.open}
        aria-controls="helper-panel"
        aria-label={state.open ? 'Close Need a hand' : 'Need a hand'}
        title={state.open ? 'Close' : canRun || state.open ? 'Need a hand' : 'Need a hand — open to see what is missing'}
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
  const mix = meta.result?.mix;
  const busy = state.running || meta.live;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40" role="dialog" aria-modal="true" aria-labelledby="helper-title">
      <button className="h-full flex-1 cursor-default" type="button" aria-label="Close Need a hand" onClick={actions.closePanel} />
      <aside
        id="helper-panel"
        className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-line bg-surface shadow-lg overscroll-contain"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="helper-title" className="text-pretty text-base font-semibold">
              Need a hand
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              We look at each seat against the golden file and this AI pack. You stay in charge — copy what you want.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" type="button" onClick={actions.closePanel}>
            Close
          </button>
        </header>
        <div className="flex shrink-0 flex-col gap-3 border-b border-line px-5 py-3">
          <button className="btn btn-primary self-start" disabled={!meta.canRun || state.running} type="button" onClick={() => void actions.run()}>
            {busy ? 'Looking…' : meta.result ? 'Look again' : 'Look at these seats'}
          </button>
          {mix ? <MixSummary mix={mix} /> : null}
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
          {busy ? <p className="text-sm text-muted">{meta.note ?? 'Looking at your seats…'}</p> : null}
          {meta.error ? <p className="text-sm text-bad">{meta.error}</p> : null}
          {mix?.refuse ? <p className="mb-4 text-sm text-bad">{mix.refuse}</p> : null}
          {meta.result ? (
            <HelperResultList result={meta.result} />
          ) : !busy && meta.missing.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              Grade the golden file and run Stability, then ask for a look. We will say which seats to leave, fix, or add.
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function MixSummary({ mix }: { mix: HelperResult['mix'] }) {
  const goldenOk = mix.predictedGolden === 100;
  const aiOk = mix.predictedCalibration >= 20 && mix.predictedCalibration < 40;
  return (
    <div className="grid grid-cols-2 gap-3">
      <ScoreCard label="Golden file" value={mix.predictedGolden} hint="Should stay 100%" ok={goldenOk} />
      <ScoreCard label="This AI pack" value={mix.predictedCalibration} hint="Aim for 20–40%" ok={aiOk} />
    </div>
  );
}

function ScoreCard({ label, value, hint, ok }: { label: string; value: number; hint: string; ok: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${ok ? 'text-ink' : 'text-bad'}`}>{Math.round(value)}%</p>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  );
}

function HelperResultList({ result }: { result: HelperResult }) {
  const { actions } = useHelper();
  return (
    <div className="space-y-8">
      <KeepSection rows={result.keep} onJump={actions.jump} />
      <ActSection rows={result.act} onCopy={actions.copy} onJump={actions.jump} />
      {result.add.length > 0 ? (
        <section className="space-y-3">
          <SectionHead title="Add these" count={result.add.length} note="The golden file has this and this AI pack missed it." />
          {result.add.map((row) => (
            <AddCard key={row.statement} row={row} onCopy={actions.copy} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function KeepSection({ rows, onJump }: { rows: HelperAnalysisRow[]; onJump: (seatId: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHead title="Leave these" count={rows.length} note="Already doing useful work. No change needed." />
      {rows.map((row) => (
        <article key={row.id} className="rounded-2xl border border-line px-4 py-3">
          <p className="text-xs font-medium text-muted">{row.tag}</p>
          <p className="mt-1 text-sm leading-6 break-words text-ink">{row.statement}</p>
          <Verdicts golden={row.golden} ai={row.ai} />
          <p className="mt-2 text-sm leading-6 text-muted">{row.reason}</p>
          <div className="mt-3">
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => onJump(row.id)}>
              Go to seat
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ActSection({
  rows,
  onCopy,
  onJump,
}: {
  rows: HelperActRow[];
  onCopy: (statement: string) => Promise<void>;
  onJump: (seatId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHead title="Fix these" count={rows.length} note="Override the grade, reword the seat, or drop it." />
      {rows.map((row) => (
        <article key={row.id} className="rounded-2xl border border-line bg-wash px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-xs font-medium text-muted">{row.tag}</p>
            <p className="text-xs font-semibold text-ink">{actionOf(row.action)}</p>
          </div>
          <p className="mt-1 text-sm leading-6 break-words text-ink">{row.statement}</p>
          <Verdicts golden={row.golden} ai={row.ai} />
          <p className="mt-2 text-sm leading-6 text-muted">{row.reason}</p>
          {row.goldenEvidence ? <p className="mt-2 text-sm leading-6 text-muted">On the golden file: {row.goldenEvidence}</p> : null}
          {row.rewrite ? (
            <div className="mt-3 rounded-xl border border-line bg-surface px-3 py-2">
              <p className="text-xs font-medium text-muted">Suggested wording</p>
              <p className="mt-1 text-sm leading-6 break-words text-ink">{row.rewrite}</p>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {row.rewrite ? (
              <button className="btn btn-sm" type="button" onClick={() => void onCopy(row.rewrite!)}>
                Copy wording
              </button>
            ) : null}
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => onJump(row.id)}>
              Go to seat
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function AddCard({ row, onCopy }: { row: HelperPackedRow; onCopy: (statement: string) => Promise<void> }) {
  return (
    <article className="rounded-2xl border border-line px-4 py-3">
      <p className="text-xs font-medium text-muted">{row.tag}</p>
      <p className="mt-1 text-sm leading-6 break-words text-ink">{row.statement}</p>
      <Verdicts golden={row.golden} ai={row.ai} />
      {row.evidence ? <p className="mt-2 text-sm leading-6 text-muted">{row.evidence}</p> : null}
      <div className="mt-3">
        <button className="btn btn-sm" type="button" onClick={() => void onCopy(row.statement)}>
          Copy
        </button>
      </div>
    </article>
  );
}

function SectionHead({ title, count, note }: { title: string; count: number; note: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">
        {title}
        <span className="ml-2 tabular-nums font-medium text-muted">{count}</span>
      </h3>
      <p className="mt-0.5 text-xs leading-5 text-muted">{note}</p>
    </div>
  );
}

function Verdicts({ golden, ai }: { golden: boolean | null; ai: boolean | null }) {
  return (
    <p className="mt-2 text-xs text-muted">
      Golden file {markOf(golden)}. This AI pack {markOf(ai)}.
    </p>
  );
}

function markOf(value: boolean | null): string {
  if (value === true) return 'passes';
  if (value === false) return 'fails';
  return 'not graded';
}

function actionOf(action: HelperActRow['action']): string {
  if (action === 'drop') return 'Drop';
  if (action === 'override') return 'Override the grade';
  if (action === 'rewrite') return 'Reword';
  return 'Leave';
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
