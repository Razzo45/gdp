'use client';

import { useState } from 'react';
import { api } from '../client';
import { formatDate, pct } from '../format';
import { Pill } from '../StageBadge';
import type { PanelProps } from './TaskWorkspace';

/**
 * Controller-only bounce / final-review ladder. The score strip stands in for
 * the gates; Submit lives in the task header.
 */
export function HandoffPanel({ view, refresh, notify }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const s = view.submission;
  const g = view.handoff.gates;

  async function move(target: string) {
    setBusy(true);
    try {
      await api(`/api/submissions/${s.id}/handoff`, { body: { target, reason } });
      setReason('');
      notify(`Handoff status: ${target.replaceAll('_', ' ')}.`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Move refused.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const status = s.handoffStatus;
  const control = view.can.control;

  return (
    <section className="card space-y-3" id="handoff">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Handoff</h2>
        <span className="badge ml-auto border-line text-muted">{status ? status.replaceAll('_', ' ') : 'Not started'}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Gate ok={g.golden} label="Golden" value={pct(view.handoff.goldenPercent)} />
        <Gate ok={g.calibration} label="Human AI eval" value={pct(view.handoff.calibrationPercent)} />
        <Gate ok={g.stability} label="Stability" value={view.handoff.stabilityScores ? view.handoff.stabilityScores.map(pct).join(' · ') : '—'} />
      </div>
      {g.reasons.length > 0 && (
        <ul className="text-xs text-warn">
          {g.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {s.stage !== 'done' && control && (
        <div className="space-y-2 border-t border-line pt-3">
          <input className="input" placeholder="Bounce reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {status && status !== 'final_review_pass' && status !== 'client_visible' && (
              <button className="btn btn-danger" disabled={busy || reason.trim().length < 5} onClick={() => move('bounced')} type="button">
                Bounce
              </button>
            )}
            {status === 'stability_pass' && (
              <button className="btn" disabled={busy || !(g.golden && g.calibration && g.stability)} onClick={() => move('final_review_pass')} type="button">
                Pass final review
              </button>
            )}
          </div>
        </div>
      )}
      {s.pushedAt && <p className="text-sm text-muted">Submitted to the Data Catalog {formatDate(s.pushedAt)}.</p>}
    </section>
  );
}

function Gate({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line p-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        <Pill tone={ok ? 'ok' : 'muted'}>{ok ? 'pass' : 'open'}</Pill>
      </div>
      <div className="mt-1 font-semibold tabular-nums">{value}</div>
    </div>
  );
}
