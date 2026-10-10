'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from './client';

/** Take a seat without opening the brief first. */
export function ClaimTask({
  submissionId,
  seat,
  label,
}: {
  submissionId: string;
  seat: 'rubric' | 'review';
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/submissions/${submissionId}/seat`, { body: { action: 'claim', seat } });
      router.push(`/submissions/${submissionId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not claim this task.');
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button className="btn btn-primary btn-sm relative z-10" disabled={busy} type="button" onClick={() => void claim()}>
        {busy ? 'Claiming…' : label ?? 'Claim'}
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
