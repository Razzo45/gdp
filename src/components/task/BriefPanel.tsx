'use client';

import { useRef, useState } from 'react';
import { FilePreview, FilePreviewList } from '../FilePreview';
import { api } from '../client';
import type { PanelProps } from './TaskWorkspace';

export function BriefPanel({ view, refresh, notify }: PanelProps) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = view.submission;
  const reviewer = view.can.lens === 'reviewer';
  const uploadsAllowed = view.can.seeAiUpload && (view.can.editRubric || view.can.control) && view.aiOutputs.length < 8;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        await api(`/api/submissions/${s.id}/ai-outputs`, { form });
      }
      notify(`${files.length} file(s) attached.`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Upload failed.', 'bad');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove(fileId: string) {
    if (!confirm('Remove this AI output file?')) return;
    try {
      await api(`/api/submissions/${s.id}/ai-outputs/${fileId}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not remove the file.', 'bad');
    }
  }

  async function sync() {
    setBusy(true);
    try {
      await api(`/api/submissions/${s.id}/sync`, { method: 'POST' });
      await refresh();
      notify('Re-read from the Catalog.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Sync failed.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const visibleFields = reviewer
    ? view.brief.fields.filter((f) => /general|task|input/i.test(f.key) || /general|task/i.test(f.label))
    : view.brief.fields;

  return (
    <section className="card space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Task brief</h2>
        {!reviewer && (
          <button className="btn btn-ghost btn-sm ml-auto" onClick={sync} disabled={busy} type="button">
            Re-sync
          </button>
        )}
        <button className={`btn btn-ghost btn-sm ${reviewer ? 'ml-auto' : ''}`} onClick={() => setOpen((o) => !o)} type="button">
          {open ? 'Hide fields' : `Show ${visibleFields.length} fields`}
        </button>
      </div>
      {open && (
        <dl className="space-y-3 text-sm">
          {visibleFields.length === 0 && <dd className="text-muted">The Catalog payload has no readable fields.</dd>}
          {visibleFields.map((f) => (
            <div key={f.key}>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">{f.label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed">{f.text}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.can.seeGoldenFiles && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Golden files</h3>
          <FilePreviewList files={view.brief.goldenFiles} hrefFor={(f) => `/api/submissions/${s.id}/files/${f.id}`} empty="No explicit Golden files were provided." />
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted">Input files</h3>
        <FilePreviewList files={view.brief.inputFiles} hrefFor={(f) => `/api/submissions/${s.id}/files/${f.id}`} empty="No input files." />
      </div>
      <div id="ai-output-files">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-medium text-muted">AI output files ({view.aiOutputs.length})</h3>
          {uploadsAllowed && (
            <>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
              <button className="btn btn-sm ml-auto" disabled={busy || view.aiOutputs.length >= 8} onClick={() => fileInput.current?.click()} type="button">
                {busy ? 'Uploading…' : 'Upload AI files'}
              </button>
            </>
          )}
        </div>
        {uploadsAllowed && <p className="mb-2 text-xs text-muted">Upload the generated artifacts to be graded (max 8 files).</p>}
        {view.aiOutputs.length === 0 ? (
          <p className="text-sm text-muted">No AI output yet. The reviewer evaluates it by hand and stability grades it three times.</p>
        ) : (
          <ul className="space-y-2">
            {view.aiOutputs.map((f) => (
              <li key={f.id} className="space-y-1">
                <FilePreview file={{ id: f.id, name: f.name, mime: f.mime }} href={`/api/submissions/${s.id}/ai-outputs/${f.id}`} />
                {uploadsAllowed && (
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => remove(f.id)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
