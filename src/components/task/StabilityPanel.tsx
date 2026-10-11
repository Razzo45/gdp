'use client';

import { useState } from 'react';
import { CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, STABILITY_CALIBRATION_TOLERANCE_POINTS, STABILITY_MAX_SPREAD_POINTS, STABILITY_PASSES } from '@/domain/gates';
import { api, uuid } from '../client';
import { formatDate, pct } from '../format';
import { Pill } from '../StageBadge';
import type { PanelProps } from './TaskWorkspace';
import { seatIndexById, seatLabel, seatsInDisplayOrder, withSeatLabels } from '@/domain/rubric';

/** Three autorater passes over the AI output. First instance: 20–50% and spread ≤5. After review, each pass must also sit within 20 of the human score before delivery. */
export function StabilityPanel({ view, refresh, notify }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const stability = view.stability;
  const statements = seatsInDisplayOrder(view.rubric?.statements ?? []);
  const seats = seatIndexById(statements);
  const running = view.jobs.find((j) => j.kind === 'stability_run' && (j.status === 'queued' || j.status === 'running'));
  const official = Boolean(view.stability?.calibrationGateActive);
  const canRun = view.can.runStability;
  const canAccept = official && canRun && view.submission.stage === 'stability';

  async function act(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      await api(path, { body });
      notify(ok);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Action failed.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const passes = stability?.passes ?? [];
  const gate = stability?.gate ?? null;
  const flips = new Set(gate?.flips ?? []);
  const rows = showAll ? statements : statements.filter((s) => flips.has(s.id) || passes.some((p) => p.errors[s.id]));

  const locked =
    !canRun && !view.can.holdsRubricSeat
      ? 'Claim the rubric seat, or ask a PM to assign it, to run Stability.'
      : canRun && view.aiOutputs.length === 0
        ? 'Attach the AI output first.'
        : null;

  return (
    <section className="card scroll-mt-4 space-y-3" id="stability">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Repeatability & Stability</h2>
        <span className="text-sm text-muted">
          {official
            ? `${STABILITY_PASSES} passes · each ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}% · spread ≤ ${STABILITY_MAX_SPREAD_POINTS} pts · each within ${STABILITY_CALIBRATION_TOLERANCE_POINTS} pts of the human score (${pct(view.handoff.calibrationPercent)})`
            : `${STABILITY_PASSES} passes · each ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}% · spread ≤ ${STABILITY_MAX_SPREAD_POINTS} pts. The human-score check applies after review.`}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {gate && (gate.ok ? <Pill tone="ok">passed</Pill> : gate.complete ? <Pill tone="bad">failed</Pill> : <Pill tone="muted">incomplete</Pill>)}
          {stability?.acceptedAt && <Pill tone="ok">accepted {formatDate(stability.acceptedAt)}</Pill>}
          {canRun && (
            canAccept && gate?.ok && stability?.groupId && !stability.acceptedAt ? (
              <button
                className="btn btn-primary"
                disabled={busy}
                type="button"
                onClick={() => act(`/api/submissions/${view.submission.id}/stability/accept`, { groupId: stability.groupId }, 'Accepted by the Rubric Team for final submission.')}
              >
                Use this Stability result
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || running !== undefined || view.aiOutputs.length === 0}
                type="button"
                onClick={() => act(`/api/submissions/${view.submission.id}/stability`, { requestId: uuid() }, 'Stability run started.')}
              >
                {running ? 'Running…' : 'Run Stability'}
              </button>
            )
          )}
        </span>
      </div>

      {passes.length > 0 && (
        <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-sm">
          {[1, 2, 3].map((i) => {
            const p = passes.find((x) => x.passIndex === i);
            const errors = p ? Object.keys(p.errors).length : 0;
            return (
              <div key={i} className="rounded-md border border-line p-2">
                <div className="text-sm text-muted">Pass {i}</div>
                <div className="text-lg font-semibold tabular-nums">{p ? pct(p.scorePercent) : running ? '…' : '—'}</div>
                {errors > 0 && <div className="text-xs text-bad">{errors} errors</div>}
              </div>
            );
          })}
        </div>
      )}

      {gate && (
        <ul className="shrink-0 text-sm">
          <li>
            Spread: <strong>{gate.spread === null ? '—' : `${(Math.round(gate.spread * 10) / 10).toFixed(1)} pts`}</strong> {gate.complete && (gate.repeatable ? <span className="text-ok">within limit</span> : <span className="text-bad">over {STABILITY_MAX_SPREAD_POINTS}</span>)}
          </li>
          <li>
            Band: {gate.complete && (gate.inBand ? <span className="text-ok">every pass {CALIBRATION_MIN_PERCENT}–{CALIBRATION_MAX_PERCENT}%</span> : <span className="text-bad">a pass is under {CALIBRATION_MIN_PERCENT}% or over {CALIBRATION_MAX_PERCENT}%</span>)}
          </li>
          {official && (
            <li>
              Against the human score: {gate.complete && (gate.withinTolerance ? <span className="text-ok">all passes within {STABILITY_CALIBRATION_TOLERANCE_POINTS} pts</span> : <span className="text-bad">a pass is more than {STABILITY_CALIBRATION_TOLERANCE_POINTS} pts away</span>)}
            </li>
          )}
          <li>
            {gate.flips.length === 0 ? 'No flips detected. Zero flips is acceptable for the stability gate.' : `Statements with changing answers (${gate.flips.length})`}
          </li>
          {gate.flips.length > 0 && (
            <li>
              Flips: {gate.flips.map((id) => seatLabel(seats.get(id))).join(', ')}
            </li>
          )}
          {gate.reasons.map((r) => (
            <li key={r} className="text-warn">
              {withSeatLabels(r, seats)}
            </li>
          ))}
        </ul>
      )}

      {(canRun || locked) && (
        <div className="flex flex-col items-start gap-2">
          {locked ? <p className="text-sm text-muted">{locked}</p> : null}
          <div className="flex flex-wrap gap-2">
            {canAccept && gate?.ok && stability?.groupId && !stability.acceptedAt && (
              <button
                className="btn"
                disabled={busy || running !== undefined || view.aiOutputs.length === 0}
                type="button"
                onClick={() => act(`/api/submissions/${view.submission.id}/stability`, { requestId: uuid() }, 'Stability run started.')}
              >
                Run again
              </button>
            )}
            {official && passes.length > 0 && (
              <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => act(`/api/submissions/${view.submission.id}/stability/reopen`, { reason: 'Rewriting flipped seats after stability.' }, 'The rubric is open again.')}>
                Reopen rubric
              </button>
            )}
          </div>
        </div>
      )}

      {passes.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-sm text-muted">
            <span>{showAll ? 'All statements' : `Flips and errors (${rows.length})`}</span>
            <button className="underline" type="button" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'show flips only' : 'show all'}
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No flips, no errors.</p>
          ) : (
            <ol className="mt-1 divide-y divide-line">
              {rows.map((s) => {
                const error = passes.map((p) => p.errors[s.id]).find((e): e is string => Boolean(e));
                const notes = passes
                  .map((p) => ({ pass: p.passIndex, text: p.evidence[s.id] }))
                  .filter((e): e is { pass: number; text: string } => Boolean(e.text));
                return (
                  <li
                    key={s.id}
                    className={`grid scroll-mt-24 gap-3 rounded-2xl py-4 [content-visibility:auto] [contain-intrinsic-size:0_8rem] md:grid-cols-[2.5rem_minmax(0,1fr)_auto] ${flips.has(s.id) ? 'bg-warn-soft px-3' : ''}`}
                  >
                    <a className="font-mono text-xs tabular-nums text-muted underline" href={`#rubric-statement-${s.id}`}>
                      {String(seats.get(s.id) ?? '').padStart(2, '0')}
                    </a>
                    <div className="min-w-0">
                      <p className="text-[15px] leading-relaxed text-pretty break-words">{s.statement}</p>
                      {error ? (
                        <p className="mt-1 text-sm text-bad">
                          {seatLabel(seats.get(s.id))}: {withSeatLabels(error, seats)}
                        </p>
                      ) : null}
                      {notes.length > 0 ? (
                        <details className="mt-2 text-sm text-muted">
                          <summary className="cursor-pointer select-none rounded-sm text-ink underline decoration-line underline-offset-2 hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                            Evidence
                          </summary>
                          <div className="mt-2 space-y-2">
                            {notes.map((note) => (
                              <p key={note.pass} className="whitespace-pre-wrap leading-snug">
                                <span className="font-medium text-ink">P{note.pass}: </span>
                                {note.text}
                              </p>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-start gap-1 self-start">
                      {[1, 2, 3].map((i) => {
                        const p = passes.find((x) => x.passIndex === i);
                        return <PassMark key={i} label={`P${i}`} value={p?.answers[s.id]} error={p?.errors[s.id]} />;
                      })}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function PassMark({ label, value, error }: { label: string; value: boolean | null | undefined; error?: string }) {
  const text = value === true ? 'Yes' : value === false ? 'No' : error ? 'err' : '—';
  const tone = value === true ? 'text-ok' : value === false || error ? 'text-bad' : 'text-muted';
  return (
    <div className="w-14 text-center" aria-label={`${label} ${text}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-base font-semibold ${tone}`}>{text}</div>
    </div>
  );
}
