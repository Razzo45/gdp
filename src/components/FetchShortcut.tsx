'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from './client';
import { Modal } from './ui/Modal';

/** ⌘K / Ctrl+K — Fetch a submission from the Catalog by id. */
export function FetchShortcut() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function openId() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ id: string }>('/api/submissions', { body: { catalogSubmissionId: id.trim() } });
      setOpen(false);
      setId('');
      router.push(`/submissions/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fetch that submission.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <Modal title="Fetch a submission" onClose={() => setOpen(false)}>
      <p className="mb-3 text-sm text-muted">Open a Catalog submission by its id. Watched projects also land here automatically.</p>
      <label className="block text-sm">
        Submission ID
        <input className="input mt-1" autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="projectSubmissionId" onKeyDown={(e) => e.key === 'Enter' && void openId()} />
      </label>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-primary" disabled={busy || !id.trim()} type="button" onClick={() => void openId()}>
          {busy ? 'Opening…' : 'Open'}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
