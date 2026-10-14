'use client';

import { useEffect, useState } from 'react';
import { api } from '../client';
import { TimeAgo } from '../TimeAgo';
import { Pill } from '../StageBadge';
import type { PanelProps } from './TaskWorkspace';

const KIND: Record<string, string> = { rubric_generate: 'Rubric generation', golden_autorate: 'Golden autorate', stability_run: 'Stability run', rubric_helper: 'Need a hand' };

interface Traffic {
  target: number;
  floor: number;
  ceiling: number;
  active: number;
  queued: number;
  cooldownMsRemaining: number;
  recent429s: number;
  files: { active: number; queued: number };
}

export function JobsPanel({ view, refresh, notify, mode = 'full' }: PanelProps & { mode?: 'full' | 'live' }) {
  const live = mode === 'live';
  const current = view.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const active = current.length > 0;
  const [open, setOpen] = useState(active);

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  useEffect(() => {
    if (live) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api<Traffic>('/api/ops/model');
        if (!cancelled) setTraffic(next);
      } catch {
        /* panel is optional */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [active, live]);

  async function cancel(id: string) {
    if (!confirm('Cancel this job?')) return;
    try {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not cancel.', 'bad');
    }
  }

  if (live) {
    if (current.length === 0) return null;
    return (
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">In progress</h2>
          <span className="text-xs text-warn">running</span>
        </div>
        <ul className="divide-y divide-line text-sm">
          {current.map((j) => (
            <JobRow key={j.id} job={j} view={view} onCancel={cancel} />
          ))}
        </ul>
      </section>
    );
  }

  if (view.jobs.length === 0 && !traffic) return null;

  return (
    <section className="card space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Jobs</h2>
        {active && <span className="text-xs text-warn">running</span>}
        <button className="btn btn-ghost btn-sm ml-auto" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : `Show ${view.jobs.length}`}
        </button>
      </div>
      {open && (
        <>
      {traffic && (
        <div className="rounded-2xl border border-line bg-wash px-3 py-2 text-xs text-muted">
          <div className="font-medium text-ink">Model traffic</div>
          <p className="mt-0.5">
            {traffic.active} active · {traffic.queued} waiting · target {traffic.target} ({traffic.floor}–{traffic.ceiling})
            {traffic.cooldownMsRemaining > 0 && ` · cooldown ${Math.ceil(traffic.cooldownMsRemaining / 1000)}s`}
            {traffic.recent429s > 0 && ` · ${traffic.recent429s} recent 429s`}
          </p>
          {(traffic.files.active > 0 || traffic.files.queued > 0) && (
            <p>Files lane: {traffic.files.active} active · {traffic.files.queued} waiting</p>
          )}
        </div>
      )}
      <ul className="divide-y divide-line text-sm">
        {view.jobs.slice(0, 6).map((j) => (
          <JobRow key={j.id} job={j} view={view} onCancel={cancel} />
        ))}
      </ul>
        </>
      )}
    </section>
  );
}

function JobRow({
  job: j,
  view,
  onCancel,
}: {
  job: PanelProps['view']['jobs'][number];
  view: PanelProps['view'];
  onCancel: (id: string) => void;
}) {
  const running = j.status === 'queued' || j.status === 'running';
  const p = j.progress ?? {};
  const ratio = p.total ? Math.min(1, (p.done ?? 0) / p.total) : 0;
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{KIND[j.kind] ?? j.kind}</span>
        <Pill tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : running ? 'warn' : 'muted'}>{j.status}</Pill>
        <span className="ml-auto text-xs text-muted">
          <TimeAgo iso={j.finishedAt ?? j.startedAt ?? j.createdAt} />
          {j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}
        </span>
        {running && view.can.holdsRubricSeat && (
          <button className="btn btn-danger btn-sm" onClick={() => onCancel(j.id)} type="button">
            Cancel
          </button>
        )}
      </div>
      {running && (
        <div className="mt-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-wash">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(4, ratio * 100)}%` }} />
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {p.note ?? (j.status === 'queued' ? 'Queued — next to generate' : 'In progress')}
            {p.total ? ` · ${p.done ?? 0}/${p.total}` : ''}
            {p.seeds ? ` · ${p.seeds.ok} ok · ${p.seeds.thin} thin · ${p.seeds.failed} failed` : ''}
          </div>
          {p.stages && p.stages.length > 0 && (
            <table className="mt-1 w-full text-[11px]">
              <tbody>
                {p.stages.map((stage, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-2 font-medium">{stage.name}</td>
                    <td className="py-0.5 text-muted">{stage.detail || (stage.state === 'active' ? 'In progress' : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {j.error && <p className="mt-1 text-xs text-bad">{j.error}</p>}
    </li>
  );
}
