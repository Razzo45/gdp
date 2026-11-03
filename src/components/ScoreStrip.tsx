'use client';

import { CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, STABILITY_CALIBRATION_TOLERANCE_POINTS, STABILITY_MAX_SPREAD_POINTS } from '@/domain/gates';
import { reviewDisplayScore } from '@/domain/review';
import { pct } from './format';
import type { SubmissionView } from '@/lib/services/view';
import { scrollTaskPanel } from './task/scrollTask';

/**
 * Compact Golden / AI Score / Stability rail — the same three numbers the
 * legacy header showed, with the same pass rules.
 */
export function ScoreStrip({
  view,
  golden: showGolden = true,
  stability: showStability = true,
  compact = false,
  livePercent,
  onOpenJobs,
}: {
  view: SubmissionView;
  golden?: boolean;
  stability?: boolean;
  compact?: boolean;
  livePercent?: number | null;
  /** Opens the brief column and scrolls to the jobs / in-progress card. */
  onOpenJobs?: () => void;
}) {
  const golden = view.golden?.gate;
  const cal = reviewDisplayScore({
    reviewer: view.can.lens === 'reviewer',
    latestPercent: livePercent !== undefined ? livePercent : view.review.latest?.scorePercent ?? null,
    submittedPercent: view.handoff.calibrationPercent,
  });
  const stability = view.stability?.gate;
  const scores = view.handoff.stabilityScores;
  const goldenRunning = view.jobs.some((j) => j.kind === 'golden_autorate' && (j.status === 'queued' || j.status === 'running'));
  const stabilityRunning = view.jobs.some((j) => j.kind === 'stability_run' && (j.status === 'queued' || j.status === 'running'));
  const linkReview = view.can.seeReviewPanel;

  const cells = [
    showGolden && {
      label: 'Golden',
      href: 'golden',
      value: pct(golden?.percent ?? null),
      rule: Object.values(view.golden?.sources ?? {}).includes('human')
        ? golden?.ok ? 'Human override · Must be 100%' : 'Human override applied'
        : golden?.ok ? 'Must be 100%' : golden?.unanswered ? `${golden.unanswered} statements left to review` : 'Must be 100%',
      tone: golden?.ok ? 'ok' : golden?.percent === null ? 'muted' : 'fix',
      running: goldenRunning,
    },
    {
      label: 'AI Score',
      href: linkReview ? 'review' : undefined,
      value: pct(cal),
      rule: `Must be ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}%`,
      tone: cal === null ? 'muted' : cal >= CALIBRATION_MIN_PERCENT && cal <= CALIBRATION_MAX_PERCENT ? 'ok' : 'fix',
      running: false,
    },
    showStability && {
      label: 'Stability',
      href: 'stability',
      value: scores?.length === 3 ? scores.map((s) => pct(s)).join(' · ') : '—',
      rule: stability?.ok
        ? `Each ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}% · spread ≤ ${STABILITY_MAX_SPREAD_POINTS}`
        : stability?.complete
          ? !stability.inBand
            ? `Each pass must be ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}%`
            : view.stability?.calibrationGateActive && !stability.withinTolerance
              ? `Each pass must be within ${STABILITY_CALIBRATION_TOLERANCE_POINTS} pts of the human score`
              : `Spread: ${stability.spread?.toFixed(1) ?? '—'} (maximum ${STABILITY_MAX_SPREAD_POINTS})`
          : '3 passes required',
      tone: stability?.ok ? 'ok' : stability?.complete ? 'fix' : 'muted',
      running: stabilityRunning,
    },
  ].filter(Boolean) as { label: string; href?: string; value: string; rule: string; tone: string; running: boolean }[];

  if (compact) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" id="submission-score-summary">
        {cells.map((c) => (
          <CompactBadge key={c.label} cell={c} onOpenJobs={onOpenJobs} />
        ))}
      </div>
    );
  }

  const cols = cells.length === 1 ? 'grid-cols-1' : cells.length === 2 ? 'grid-cols-2' : 'grid-cols-3';

  return (
    <div className={`grid min-w-0 flex-1 ${cols} gap-2`} id="submission-score-summary">
      {cells.map((c) => (
        <Cell key={c.label} cell={c} onOpenJobs={onOpenJobs} />
      ))}
    </div>
  );
}

function jump(href: string | undefined, event?: { preventDefault(): void; stopPropagation(): void }) {
  event?.preventDefault();
  event?.stopPropagation();
  if (href) scrollTaskPanel(href);
}

function CompactBadge({
  cell,
  onOpenJobs,
}: {
  cell: { label: string; href?: string; value: string; rule: string; tone: string; running: boolean };
  onOpenJobs?: () => void;
}) {
  const cls = `badge ${cell.tone === 'ok' ? 'badge-ok' : cell.tone === 'fix' ? 'badge-warn' : 'badge-muted'}`;
  if (!cell.href && !cell.running) {
    return (
      <span className={cls} title={cell.rule}>
        {cell.label} {cell.value}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {cell.href ? (
        <button type="button" className={cls} title={cell.rule} onClick={(e) => jump(cell.href, e)}>
          {cell.label} {cell.value}
        </button>
      ) : (
        <span className={cls} title={cell.rule}>
          {cell.label} {cell.value}
        </span>
      )}
      {cell.running && onOpenJobs ? (
        <button type="button" className="text-[11px] font-semibold text-warn underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); onOpenJobs(); }}>
          Progress
        </button>
      ) : null}
    </span>
  );
}

function Cell({
  cell,
  onOpenJobs,
}: {
  cell: { label: string; href?: string; value: string; rule: string; tone: string; running: boolean };
  onOpenJobs?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{cell.label}</span>
        <span className={`badge ${cell.tone === 'ok' ? 'badge-ok' : cell.tone === 'fix' ? 'badge-warn' : 'badge-muted'}`}>
          {cell.tone === 'ok' ? 'Pass' : cell.tone === 'fix' ? 'Fix' : 'In progress'}
        </span>
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight">{cell.value}</div>
      <div className="truncate text-[11px] text-quiet" title={cell.rule}>
        {cell.rule}
      </div>
    </>
  );
  const shell = 'min-w-0 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left';
  const progress =
    cell.running && onOpenJobs ? (
      <button type="button" className="mt-1 text-[11px] font-semibold text-warn hover:underline" onClick={onOpenJobs}>
        View progress
      </button>
    ) : null;

  if (cell.href) {
    return (
      <div className={`${shell} hover:bg-wash`}>
        <button type="button" className="block w-full cursor-pointer text-left" onClick={(e) => jump(cell.href, e)}>
          {body}
        </button>
        {progress}
      </div>
    );
  }
  return (
    <div className={shell}>
      {body}
      {progress}
    </div>
  );
}
