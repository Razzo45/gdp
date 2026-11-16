'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './client';
import { TimeAgo } from './TimeAgo';

interface Cook {
  id: string;
  sessionId: string;
  status: string;
  line: string;
  updatedAt: string;
  prompt: string;
  brain: 'Argon' | 'Carbon';
  active: boolean;
}

function badge(status: string): string {
  if (status === 'exported') return 'badge badge-ok';
  if (status === 'failed' || status === 'rejected') return 'badge badge-bad';
  if (status === 'queued' || status === 'generating' || status === 'stitching') return 'badge badge-warn';
  return 'badge badge-muted';
}

export function CooksPanel() {
  const [cooks, setCooks] = useState<Cook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<{ cooks: Cook[] }>('/api/cooks');
      setCooks(next.cooks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load cooks.');
    }
  }, []);

  useEffect(() => {
    void load();
    const handle = setInterval(() => void load(), 2500);
    return () => clearInterval(handle);
  }, [load]);

  async function cancel(cook: Cook) {
    const word = cook.active ? 'Cancel' : 'Delete';
    if (!confirm(`${word} ${cook.id}?`)) return;
    setBusy(cook.id);
    try {
      await api(`/api/cooks/${encodeURIComponent(cook.id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that cook.');
    } finally {
      setBusy(null);
    }
  }

  if (!cooks && !error) return <p className="text-sm text-muted">Loading cooks…</p>;

  const active = cooks?.filter((cook) => cook.active) ?? [];
  const finished = cooks?.filter((cook) => !cook.active) ?? [];

  return (
    <div className="space-y-5">
      {error ? <p className="text-sm text-warn">{error}</p> : null}
      <section className="card">
        <h2 className="section-title mb-1 text-lg">In progress ({active.length})</h2>
        <p className="mb-4 text-sm text-muted">Cancel removes that cook. An encode already running keeps the worker until it finishes.</p>
        {active.length === 0 ? <p className="text-sm text-muted">Nothing is cooking.</p> : <CookList cooks={active} busy={busy} onCancel={cancel} />}
      </section>
      <section className="card">
        <h2 className="section-title mb-4 text-lg">Recent ({finished.length})</h2>
        {finished.length === 0 ? <p className="text-sm text-muted">No finished cooks yet.</p> : <CookList cooks={finished} busy={busy} onCancel={cancel} />}
      </section>
    </div>
  );
}

function CookList({ cooks, busy, onCancel }: { cooks: Cook[]; busy: string | null; onCancel: (cook: Cook) => void }) {
  return (
    <ul className="divide-y divide-line">
      {cooks.map((cook) => (
        <li key={cook.id} className="flex items-start justify-between gap-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={badge(cook.status)}>{cook.status}</span>
              <span className="badge badge-muted">{cook.brain ?? 'Argon'}</span>
              <span className="font-mono text-xs text-muted">{cook.id}</span>
              {cook.updatedAt ? (
                <span className="text-xs text-muted">
                  <TimeAgo iso={cook.updatedAt} />
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-ink">{cook.line}</p>
            {cook.prompt ? <p className="mt-1 line-clamp-2 text-xs text-muted">{cook.prompt}</p> : null}
          </div>
          <button className="btn btn-danger btn-sm shrink-0" type="button" disabled={busy === cook.id} onClick={() => onCancel(cook)}>
            {busy === cook.id ? '…' : cook.active ? 'Cancel' : 'Delete'}
          </button>
        </li>
      ))}
    </ul>
  );
}
