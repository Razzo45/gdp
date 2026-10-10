'use client';

import { useEffect } from 'react';

/** Timed, dismissible notice. Errors never stay on screen without a close. */
export function Toast({
  message,
  tone = 'ok',
  onDone,
}: {
  message: string;
  tone?: 'ok' | 'bad';
  onDone: () => void;
}) {
  useEffect(() => {
    const handle = window.setTimeout(onDone, tone === 'ok' ? 4000 : 8000);
    return () => window.clearTimeout(handle);
  }, [message, tone, onDone]);

  return (
    <div
      className={`fixed right-4 top-16 z-50 flex max-w-md items-start gap-3 rounded-2xl border px-3 py-2 text-sm ${tone === 'ok' ? 'border-ok bg-ok-soft text-ok' : 'border-bad bg-bad-soft text-bad'}`}
      role="status"
    >
      <p className="min-w-0 flex-1">{message}</p>
      <button className="btn btn-ghost btn-sm shrink-0 px-2 text-current" type="button" onClick={onDone} aria-label="Dismiss">
        Close
      </button>
    </div>
  );
}
