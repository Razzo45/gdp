import { CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, STABILITY_CALIBRATION_TOLERANCE_POINTS, STABILITY_MAX_SPREAD_POINTS } from '@/domain/gates';
import { reviewDisplayScore } from '@/domain/review';
import { pct } from './format';
import type { SubmissionView } from '@/lib/services/view';

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
}: {
  view: SubmissionView;
  golden?: boolean;
  stability?: boolean;
  compact?: boolean;
  livePercent?: number | null;
}) {
  const golden = view.golden?.gate;
  const cal = reviewDisplayScore({
    reviewer: view.can.lens === 'reviewer',
    latestPercent: livePercent !== undefined ? livePercent : view.review.latest?.scorePercent ?? null,
    submittedPercent: view.handoff.calibrationPercent,
  });
  const stability = view.stability?.gate;
  const scores = view.handoff.stabilityScores;

  const cells = [
    showGolden && {
      label: 'Golden',
      value: pct(golden?.percent ?? null),
      rule: Object.values(view.golden?.sources ?? {}).includes('human')
        ? golden?.ok ? 'Human override · Must be 100%' : 'Human override applied'
        : golden?.ok ? 'Must be 100%' : golden?.unanswered ? `${golden.unanswered} statements left to review` : 'Must be 100%',
      tone: golden?.ok ? 'ok' : golden?.percent === null ? 'muted' : 'fix',
    },
    {
      label: 'AI Score',
      value: pct(cal),
      rule: `Must be ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}%`,
      tone: cal === null ? 'muted' : cal >= CALIBRATION_MIN_PERCENT && cal <= CALIBRATION_MAX_PERCENT ? 'ok' : 'fix',
    },
    showStability && {
      label: 'Stability',
      href: '#stability',
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
    },
  ].filter(Boolean) as { label: string; href?: string; value: string; rule: string; tone: string }[];

  if (compact) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" id="submission-score-summary">
        {cells.map((c) => (
          <span
            key={c.label}
            className={`badge ${c.tone === 'ok' ? 'badge-ok' : c.tone === 'fix' ? 'badge-warn' : 'badge-muted'}`}
            title={c.rule}
          >
            {c.label} {c.value}
          </span>
        ))}
      </div>
    );
  }

  const cols = cells.length === 1 ? 'grid-cols-1' : cells.length === 2 ? 'grid-cols-2' : 'grid-cols-3';

  return (
    <div className={`grid min-w-0 flex-1 ${cols} gap-2`} id="submission-score-summary">
      {cells.map((c) => (
        <Cell key={c.label} href={c.href} tone={c.tone} label={c.label} value={c.value} rule={c.rule} />
      ))}
    </div>
  );
}

function Cell({ href, tone, label, value, rule }: { href?: string; tone: string; label: string; value: string; rule: string }) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className={`badge ${tone === 'ok' ? 'badge-ok' : tone === 'fix' ? 'badge-warn' : 'badge-muted'}`}>
          {tone === 'ok' ? 'Pass' : tone === 'fix' ? 'Fix' : 'In progress'}
        </span>
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="truncate text-[11px] text-quiet" title={rule}>{rule}</div>
    </>
  );
  const cls = 'min-w-0 rounded-2xl border border-line bg-surface px-3 py-2.5';
  return href ? (
    <a href={href} className={`${cls} block no-underline`}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
