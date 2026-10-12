'use client';

import { useState } from 'react';
import { canConfirmStabilityPassFrom } from '@/domain/gates';
import { api } from '../client';
import { formatDate, pct } from '../format';
import { Pill } from '../StageBadge';
import { Modal } from '../ui/Modal';
import type { PanelProps } from './TaskWorkspace';

/**
 * Handoff ladder and Catalog push.
 *   ready_for_review → bounced | stability_pass → final_review_pass → (push) client_visible
 */
export function HandoffPanel({ view, refresh, notify }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmPush, setConfirmPush] = useState(false);
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

  const status = s.handoffStatus;
  const creator = view.can.holdsRubricSeat;
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

      {s.stage !== 'done' && (
        <div className="space-y-2 border-t border-line pt-3">
          <input className="input" placeholder="Bounce reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {creator && (status === null || status === 'bounced') && !(g.golden && g.calibration && g.stability) && (
              <button className="btn" disabled={busy || !g.golden} onClick={() => move('ready_for_review')} type="button">
                Mark ready for review
              </button>
            )}
            {creator && canConfirmStabilityPassFrom(status) && (
              <button className="btn" disabled={busy || !(g.golden && g.calibration && g.stability)} onClick={() => move('stability_pass')} type="button">
                Confirm stability pass
              </button>
            )}
            {control && status && status !== 'final_review_pass' && status !== 'client_visible' && (
              <button className="btn btn-danger" disabled={busy || reason.trim().length < 5} onClick={() => move('bounced')} type="button">
                Bounce
              </button>
            )}
            {control && status === 'stability_pass' && (
              <button className="btn btn-primary" disabled={busy || !(g.golden && g.calibration && g.stability)} onClick={() => move('final_review_pass')} type="button">
                Pass final review
              </button>
            )}
            {view.can.push && (
              <button className="btn btn-primary" disabled={busy} onClick={() => setConfirmPush(true)} type="button">
                Submit to Data Program
              </button>
            )}
          </div>
        </div>
      )}
      {s.pushedAt && <p className="text-sm text-muted">Submitted to the Data Catalog {formatDate(s.pushedAt)}.</p>}

      {confirmPush && (
        <Modal title="Submit to Data Program" onClose={() => setConfirmPush(false)}>
          <p className="text-sm text-muted">Write the rubric and performance summary into the Catalog and move the submission to the handoff status. This cannot be undone here.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy} type="button" onClick={push}>
              {busy ? 'Submitting…' : 'Submit to Data Program'}
            </button>
            <button className="btn" type="button" onClick={() => setConfirmPush(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
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
