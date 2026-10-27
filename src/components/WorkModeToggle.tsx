'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { api } from '@/components/client';
import type { WorkMode } from '@/domain/workMode';

/** Dual-role hat switch: one click, cookie set, board refreshes. */
export function WorkModeToggle({ mode }: { mode: WorkMode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function choose(next: WorkMode) {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      await api('/api/me/work-mode', { body: { mode: next } });
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;

  return (
    <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Work as">
      <ModeButton active={mode === 'rubric'} disabled={disabled} onClick={() => void choose('rubric')}>
        Rubric
      </ModeButton>
      <ModeButton active={mode === 'review'} disabled={disabled} onClick={() => void choose('review')}>
        Review
      </ModeButton>
    </div>
  );
}

/** One-line nudge when the other hat still holds seats. */
export function WorkModeNudge({
  mode,
  otherHatCount,
}: {
  mode: WorkMode;
  otherHatCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  if (otherHatCount <= 0) return null;

  const other: WorkMode = mode === 'rubric' ? 'review' : 'rubric';
  const label = other === 'review' ? 'review' : 'rubric';
  const switchLabel = other === 'review' ? 'Review' : 'Rubric';

  async function switchMode() {
    if (busy) return;
    setBusy(true);
    try {
      await api('/api/me/work-mode', { body: { mode: other } });
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="text-sm text-muted">
      You also hold {otherHatCount} {label} seat{otherHatCount === 1 ? '' : 's'} —{' '}
      <button
        type="button"
        className="font-medium text-accent-text underline decoration-line underline-offset-2 hover:text-ink disabled:opacity-60"
        disabled={busy || pending}
        onClick={() => void switchMode()}
      >
        switch to {switchLabel}
      </button>
    </p>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${
        active ? 'bg-wash text-ink' : 'text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}
