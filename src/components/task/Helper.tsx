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
  const note = view.helper?.progress.note ?? (live ? 'Queued behind other work…' : null);
  const error = view.helper?.error ?? null;

  const run = useCallback(async () => {
    setRunning(true);
    setOpen(true);
    try {
      await api(`/api/submissions/${view.submission.id}/helper`, { body: { requestId: crypto.randomUUID() } });
      notify('Need a hand is classifying seats. It waits until Golden and factory work finish.');
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not start the helper.', 'bad');
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
    meta: { missing, live, autorateLocked, canRun },
  } = useHelper();
  const blocked = !canRun
    ? autorateLocked
      ? 'Wait until Golden autorate finishes.'
      : live
        ? 'A hand is already running.'
        : missing[0] ?? 'Claim the rubric seat to run this.'
    : null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2">
      {blocked && !state.open ? <p className="pointer-events-none max-w-xs rounded-2xl bg-surface/95 px-3 py-2 text-xs text-muted shadow-sm">{blocked}</p> : null}
      <button
        className="pointer-events-auto btn btn-primary shadow-lg"
        type="button"
        aria-expanded={state.open}
        title={blocked ?? 'Open Need a hand'}
        onClick={() => (state.open ? actions.closePanel() : actions.openPanel())}
      >
        Need a hand
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
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-900/40" role="dialog" aria-modal="true" aria-labelledby="helper-title">
      <button className="h-full flex-1 cursor-default" type="button" aria-label="Close helper" onClick={actions.closePanel} />
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-line bg-surface shadow-lg">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 id="helper-title" className="text-base font-semibold">
              Need a hand
            </h2>
            <p className="mt-1 text-sm text-muted">Classify first. Golden 100 is every seated row true on the human file. Under 40 is calibration on this AI pack. Stability is spread ≤ 5, not a 40% score.</p>
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={actions.closePanel}>
            Close
          </button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <button className="btn btn-primary" disabled={!meta.canRun || state.running} type="button" onClick={() => void actions.run()}>
            {state.running || meta.live ? 'Working…' : meta.result ? 'Classify again' : 'Classify seats'}
          </button>
          {mix ? (
            <p className={`text-xs ${mix.ready ? 'text-muted' : 'text-bad'}`}>
              predicted Golden {Math.round(mix.predictedGolden)} · calibration {Math.round(mix.predictedCalibration)}
              {mix.ready ? ' · batch is inside the gates' : ''}
            </p>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {meta.missing.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
              {meta.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          ) : null}
          {meta.autorateLocked ? <p className="text-sm text-muted">Golden autorate is running. The helper waits so it does not steal a slot.</p> : null}
          {meta.live || state.running ? <p className="text-sm text-muted">{meta.note ?? 'Classifying seats…'}</p> : null}
          {meta.error ? <p className="text-sm text-bad">{meta.error}</p> : null}
          {mix?.refuse ? <p className="mb-4 text-sm text-bad">{mix.refuse}</p> : null}
          {meta.result ? <HelperResultList result={meta.result} /> : !meta.live && meta.missing.length === 0 ? <p className="text-sm text-muted">Run it after Golden and an AI pack grade. It classifies each seat before it offers a rewrite.</p> : null}
        </div>
      </aside>
    </div>
  );
}

function HelperResultList({ result }: { result: HelperResult }) {
  const { actions } = useHelper();
  return (
    <div className="space-y-6">
      <KeepSection rows={result.keep} onJump={actions.jump} />
      <ActSection rows={result.act} onCopy={actions.copy} onJump={actions.jump} />
      {result.add.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Add — measured Golden Yes / AI No</h3>
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
          <h3 className="text-sm font-semibold">Keep — discriminators and required locks</h3>
      {rows.map((row) => (
        <article key={row.id} className="rounded-2xl border border-line px-4 py-3">
          <p className="text-xs font-semibold text-muted">{row.tag} · {labelOf(row.bucket)}</p>
          <p className="mt-1 text-sm text-ink">{row.statement}</p>
          <p className="mt-2 text-xs text-muted">{row.reason}</p>
          <div className="mt-3">
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => onJump(row.id)}>
              Jump to seat
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
      <h3 className="text-sm font-semibold">Act — override, reword, or drop</h3>
      {rows.map((row) => (
        <article key={row.id} className="rounded-2xl border border-line bg-wash px-4 py-3">
          <p className="text-xs font-semibold text-muted">{row.tag} · {labelOf(row.bucket)} · {row.action}</p>
          <p className="mt-1 text-sm text-ink">{row.statement}</p>
          <p className="mt-2 text-xs text-muted">{row.reason}</p>
          {row.goldenEvidence ? <p className="mt-1 text-xs text-muted">Golden evidence: {row.goldenEvidence}</p> : null}
          {row.rewrite ? (
            <div className="mt-3 rounded-xl border border-line bg-surface px-3 py-2">
              <p className="text-xs font-semibold text-muted">Reword to this</p>
              <p className="mt-1 text-sm text-ink">{row.rewrite}</p>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {row.rewrite ? (
              <button className="btn btn-sm" type="button" onClick={() => void onCopy(row.rewrite!)}>
                Copy reword
              </button>
            ) : null}
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => onJump(row.id)}>
              Jump to seat
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
      <p className="text-xs font-semibold text-muted">{row.tag} · predicted AI No</p>
      <p className="mt-1 text-sm text-ink">{row.statement}</p>
      {row.evidence ? <p className="mt-2 text-xs text-muted">{row.evidence}</p> : null}
      <div className="mt-3">
        <button className="btn btn-sm" type="button" onClick={() => void onCopy(row.statement)}>
          Copy
        </button>
      </div>
    </article>
  );
}

function labelOf(bucket: HelperAnalysisRow['bucket']): string {
  if (bucket === 'discriminator') return 'keep';
  if (bucket === 'hygiene') return 'yes on both';
  if (bucket === 'rater_noise') return 'override';
  if (bucket === 'false_on_golden') return 'false on golden';
  if (bucket === 'happenstance') return 'happenstance';
  if (bucket === 'soft') return 'soft';
  if (bucket === 'duplicate') return 'duplicate';
  return 'ungraded';
}

export const Helper = {
  Provider: HelperProvider,
  Launcher: HelperLauncher,
  Panel: HelperPanel,
};
