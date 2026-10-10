import type { ReactNode } from 'react';

const STAGE_STYLE: Record<string, string> = {
  rubric: 'badge-brand',
  review: 'badge-warn',
  stability: 'badge-check',
  handoff: 'badge-ok',
  done: 'badge-muted',
};

export const STAGE_LABEL: Record<string, string> = {
  rubric: 'Rubric & Golden',
  review: 'Human AI eval',
  stability: 'Stability',
  handoff: 'Handoff',
  done: 'Delivered',
};

export function StageBadge({ stage }: { stage: string }) {
  return <span className={`badge ${STAGE_STYLE[stage] ?? 'badge-muted'}`}>{STAGE_LABEL[stage] ?? stage}</span>;
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  const style = { ok: 'badge-ok', warn: 'badge-warn', bad: 'badge-bad', muted: 'badge-muted' }[tone];
  return <span className={`badge ${style}`}>{children}</span>;
}
