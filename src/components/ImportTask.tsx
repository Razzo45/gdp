'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from './client';

/** Bring a Catalog submission onto the platform by id (webhooks do this automatically for watched projects). */
export function ImportTask() {
  const router = useRouter();
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ id: string }>('/api/submissions', { body: { catalogSubmissionId: id.trim() } });
      router.push(`/submissions/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-2">
      <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
        Fetch a submission
        <input className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="projectSubmissionId" required />
      </label>
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? 'Reading…' : 'Import'}
      </button>
      {error && <p className="w-full text-sm text-bad">{error}</p>}
    </form>
  );
}
