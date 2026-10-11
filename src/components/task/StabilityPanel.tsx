'use client';

import { useState } from 'react';
import { STABILITY_CALIBRATION_TOLERANCE_POINTS, STABILITY_MAX_SPREAD_POINTS, STABILITY_PASSES } from '@/domain/gates';
import { api, uuid } from '../client';
import { formatDate, pct } from '../format';
import { Pill } from '../StageBadge';
import type { PanelProps } from './TaskWorkspace';
import { seatIndexById, seatLabel, seatsInDisplayOrder, withSeatLabels } from '@/domain/rubric';

/** Three autorater passes over the AI output. Preview before review is repeatability only; after approval, spread ≤5 and each pass within 20 of the human score, then explicit accept. */
export function StabilityPanel({ view, refresh, notify }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const stability = view.stability;
  const statements = seatsInDisplayOrder(view.rubric?.statements ?? []);
  const seats = seatIndexById(statements);
  const running = view.jobs.find((j) => j.kind === 'stability_run' && (j.status === 'queued' || j.status === 'running'));
  const official = view.submission.stage === 'stability';
  const canRun = view.can.runStability;
  const canAccept = official && canRun;

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
    !canRun && view.submission.stage === 'review'
      ? 'Stability is locked while review is pending.'
      : !canRun && !view.can.holdsRubricSeat
        ? 'Claim the rubric seat, or ask a PM to assign it, to run Stability.'
        : canRun && view.aiOutputs.length === 0
          ? 'Attach the AI output first.'
          : null;

  return (
    <section className="card space-y-3" id="stability">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Repeatability & Stability</h2>
        <span className="text-sm text-muted">
          {official
            ? `${STABILITY_PASSES} passes · spread ≤ ${STABILITY_MAX_SPREAD_POINTS} pts · each within ${STABILITY_CALIBRATION_TOLERANCE_POINTS} pts of the human score (${pct(view.handoff.calibrationPercent)})`
            : `${STABILITY_PASSES} passes against the current rubric and AI files to measure repeatability. Reviewer scores do not participate.`}
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
            <button className="underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'show flips only' : 'show all'}
            </button>
          </div>
          <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead className="sticky top-0 z-10 bg-surface text-left text-muted">
              <tr>
                <th className="py-2 pr-3">Seat</th>
                <th className="py-2 pr-3">Statement</th>
                {[1, 2, 3].map((i) => (
                  <th key={i} className="w-[18%] py-2 pr-3 align-bottom">
                    P{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s) => (
                <tr key={s.id} className={flips.has(s.id) ? 'bg-warn-soft' : ''}>
                  <td className="py-2 pr-3 align-top font-mono tabular-nums">
                    <a className="underline" href={`#rubric-statement-${s.id}`}>
                      {seats.get(s.id) ?? '—'}
                    </a>
                  </td>
                  <td className="py-2 pr-3 align-top text-base leading-snug">
                    {s.statement}
                    {passes.map((p) => p.errors[s.id]).filter((e): e is string => Boolean(e)).slice(0, 1).map((e) => (
                      <div key={e} className="text-bad">
                        {seatLabel(seats.get(s.id))}: {withSeatLabels(e, seats)}
                      </div>
                    ))}
                  </td>
                  {[1, 2, 3].map((i) => {
                    const p = passes.find((x) => x.passIndex === i);
                    const v = p?.answers[s.id];
                    const ev = p?.evidence[s.id];
                    return (
                      <td key={i} className="py-2 pr-3 align-top">
                        <div className={`text-base font-medium ${v === true ? 'text-ok' : v === false || p?.errors[s.id] ? 'text-bad' : ''}`}>
                          {v === true ? 'Yes' : v === false ? 'No' : p?.errors[s.id] ? 'err' : '—'}
                        </div>
                        {ev ? <p className="mt-1 text-sm leading-snug text-muted">{ev}</p> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-center text-muted">
                    No flips, no errors.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </section>
  );
}
