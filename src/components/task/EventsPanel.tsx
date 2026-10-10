'use client';

import { useState } from 'react';
import { formatDate } from '../format';
import type { PanelProps } from './TaskWorkspace';

export function EventsPanel({ view }: PanelProps) {
  const [open, setOpen] = useState(false);
  const events = view.events;
  if (events.length === 0) return null;
  return (
    <section className="card">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">History</h2>
        <button className="btn btn-ghost btn-sm ml-auto" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : `Show ${events.length}`}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1 text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2">
              <span className="w-32 shrink-0 text-muted">{formatDate(e.createdAt)}</span>
              <span className="shrink-0 font-medium">{e.action.replaceAll('_', ' ')}</span>
              <span className="text-muted">{e.actorId ? (view.people[e.actorId]?.name ?? '') : 'system'}</span>
              {Object.keys(e.detail).length > 0 && <span className="truncate text-quiet" title={JSON.stringify(e.detail)}>{summary(e.detail)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function summary(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
}
