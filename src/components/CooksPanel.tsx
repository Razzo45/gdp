'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './client';
import { TimeAgo } from './TimeAgo';

interface Cook {
  id: string;
  sessionId: string;
  status: string;
  line: string;
  phase: string;
  createdAt: string;
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

function sessionLabel(sessionId: string): string {
  const raw = sessionId.trim();
  if (!raw) return '';
  const cut = raw.match(/gdp-([a-f0-9]+)/i)?.[1];
  if (cut) return `task ${cut.slice(0, 8)}`;
  return raw.length > 28 ? `${raw.slice(0, 28)}…` : raw;
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
    setBusy(`${cook.id}:delete`);
    try {
      await api(`/api/cooks/${encodeURIComponent(cook.id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that cook.');
    } finally {
      setBusy(null);
    }
  }

  async function retry(cook: Cook) {
    setBusy(`${cook.id}:retry`);
    try {
      await api(`/api/cooks/${encodeURIComponent(cook.id)}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry that cook.');
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
        <p className="mb-4 text-sm text-muted">
          Order stays fixed while a cook is live. Cancel removes that cook. An encode already running keeps the worker until it finishes.
        </p>
        {active.length === 0 ? (
          <p className="text-sm text-muted">Nothing is cooking.</p>
        ) : (
          <CookList cooks={active} busy={busy} onCancel={cancel} onRetry={retry} />
        )}
      </section>
      <section className="card">
        <h2 className="section-title mb-4 text-lg">Recent ({finished.length})</h2>
        {finished.length === 0 ? (
          <p className="text-sm text-muted">No finished cooks yet.</p>
        ) : (
          <CookList cooks={finished} busy={busy} onCancel={cancel} onRetry={retry} />
        )}
      </section>
    </div>
  );
}

function CookList({
  cooks,
  busy,
  onCancel,
  onRetry,
}: {
  cooks: Cook[];
  busy: string | null;
  onCancel: (cook: Cook) => void;
  onRetry: (cook: Cook) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {cooks.map((cook) => {
        const task = sessionLabel(cook.sessionId);
        const working = busy === `${cook.id}:retry` || busy === `${cook.id}:delete`;
        return (
          <li key={cook.id} className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={badge(cook.status)}>{cook.phase || cook.status}</span>
                <span className="badge badge-muted">{cook.brain ?? 'Argon'}</span>
                {task ? <span className="text-xs font-medium text-ink">{task}</span> : null}
                {cook.updatedAt ? (
                  <span className="text-xs text-muted">
                    <TimeAgo iso={cook.updatedAt} />
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm font-medium leading-6 text-ink">{cook.line}</p>
              {cook.prompt ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{cook.prompt}</p> : null}
              <p className="mt-1 font-mono text-[11px] text-quiet">{cook.id}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {cook.status === 'failed' ? (
                <button className="btn btn-sm" type="button" disabled={working} onClick={() => onRetry(cook)}>
                  {busy === `${cook.id}:retry` ? '…' : 'Retry'}
                </button>
              ) : null}
              <button className="btn btn-danger btn-sm" type="button" disabled={working} onClick={() => onCancel(cook)}>
                {busy === `${cook.id}:delete` ? '…' : cook.active ? 'Cancel' : 'Delete'}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
