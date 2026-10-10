'use client';

import { useState, type FormEvent } from 'react';
import type { WatchedProjectView } from '@/lib/services/admin';
import { api } from '../client';
import { formatDate } from '../format';

/**
 * Watched Catalog projects. The webhook only imports submissions from
 * projects listed here; the two status ids tell the push where the
 * submission must be moved after the rubric is written back.
 */
export function ProjectsAdmin({ initial }: { initial: WatchedProjectView[] }) {
  const [projects, setProjects] = useState(initial);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  async function reload() {
    const result = await api<{ projects: WatchedProjectView[] }>('/api/projects');
    setProjects(result.projects);
  }

  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await reload();
      if (ok) setMessage({ text: ok });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Request failed.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api('/api/projects', { body: { projectId } });
      setProjectId('');
    }, 'Project added. Pick the work and handoff statuses below.');
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="page-kicker">Wirestock · GDP</p>
        <h1 className="page-title mt-1">Integrations</h1>
        <p className="mt-1 text-sm text-muted">Data Catalog projects this platform watches, and the work / handoff statuses for import and push.</p>
      </div>
      <form onSubmit={add} className="card flex flex-wrap items-center gap-2">
        <input className="input flex-1" required placeholder="Catalog project id" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <button className="btn btn-primary" disabled={busy} type="submit">
          Watch project
        </button>
        {message && <span className={`w-full text-sm ${message.bad ? 'text-bad' : 'text-ok'}`}>{message.text}</span>}
      </form>

      {projects.length === 0 && <p className="card text-sm text-muted">Watching every project is not the default here — add the Catalog projects this team owns. Webhook events for unknown projects are ignored.</p>}

      {projects.map((p) => (
        <section key={p.projectId} className="card space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <input className="input w-72 py-0.5 font-semibold" defaultValue={p.label} disabled={busy} onBlur={(e) => e.target.value.trim() !== p.label && run(async () => void (await api(`/api/projects/${p.projectId}`, { method: 'PATCH', body: { label: e.target.value } })))} />
            <span className="font-mono text-xs text-muted">{p.projectId}</span>
            <span className="ml-auto text-xs text-muted">statuses fetched {formatDate(p.projectFetchedAt)}</span>
            <button className="btn btn-sm" disabled={busy} type="button" onClick={() => run(async () => void (await api('/api/projects', { body: { projectId: p.projectId } })), 'Refreshed project statuses.')}>
              Refresh
            </button>
            <button className="btn btn-danger btn-sm" disabled={busy} type="button" onClick={() => confirm(`Stop watching ${p.label}? Existing tasks stay.`) && run(async () => void (await api(`/api/projects/${p.projectId}`, { method: 'DELETE' })))}>
              Remove
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusPicker label="Data Program work stage" value={p.workStatusId} statuses={p.statuses} disabled={busy} onChange={(v) => run(async () => void (await api(`/api/projects/${p.projectId}`, { method: 'PATCH', body: { workStatusId: v } })))} />
            <StatusPicker label="Handoff stage" value={p.handoffStatusId} statuses={p.statuses} disabled={busy} onChange={(v) => run(async () => void (await api(`/api/projects/${p.projectId}`, { method: 'PATCH', body: { handoffStatusId: v } })))} />
          </div>
          {p.statuses.length === 0 && <p className="text-xs text-warn">The Catalog project did not expose a workflow; status ids must be typed by hand.</p>}
        </section>
      ))}
    </div>
  );
}

function StatusPicker({ label, value, statuses, disabled, onChange }: { label: string; value: string | null; statuses: { id: string; name: string | null }[]; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      {statuses.length > 0 ? (
        <select className="input mt-0.5" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">— not set —</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.id}
            </option>
          ))}
        </select>
      ) : (
        <input className="input mt-0.5" defaultValue={value ?? ''} disabled={disabled} onBlur={(e) => e.target.value !== (value ?? '') && onChange(e.target.value)} placeholder="status id" />
      )}
    </label>
  );
}
