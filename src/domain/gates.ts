/**
 * Every numeric gate in one place. These are the acceptance rules from the
 * existing platform and they are not configurable:
 *
 *   Golden        every statement graded Yes, no errors            → 100%
 *   Calibration   human AI-output score inside [20, 50] inclusive
 *   Stability     three passes, spread ≤ 5 points, every pass inside
 *                 [20, 50]. After review, every pass must also sit within
 *                 20 points of the human score (delivery only).
 */

export const GOLDEN_REQUIRED_PERCENT = 100;
export const CALIBRATION_MIN_PERCENT = 20;
export const CALIBRATION_MAX_PERCENT = 50;
export const STABILITY_MAX_SPREAD_POINTS = 5;
export const STABILITY_CALIBRATION_TOLERANCE_POINTS = 20;
export const STABILITY_PASSES = 3;
/** Observation required on Golden overrides and submitted review grades. */
export const EVIDENCE_MIN_CHARS = 5;

export type Verdict = boolean | null;

export interface ScoreBreakdown {
  yes: number;
  no: number;
  unanswered: number;
  total: number;
  /** yes / (yes + no); null when nothing is graded. */
  percent: number | null;
}

export function scoreBreakdown(answers: Record<string, Verdict>, statementIds: readonly string[]): ScoreBreakdown {
  let yes = 0;
  let no = 0;
  for (const id of statementIds) {
    const v = answers[id];
    if (v === true) yes += 1;
    else if (v === false) no += 1;
  }
  const graded = yes + no;
  return {
    yes,
    no,
    unanswered: statementIds.length - graded,
    total: statementIds.length,
    percent: graded === 0 ? null : (yes / graded) * 100,
  };
}

export interface GoldenGate {
  ok: boolean;
  percent: number | null;
  unanswered: number;
  errors: number;
  reasons: string[];
}

export function goldenGate(input: {
  answers: Record<string, Verdict>;
  errors: Record<string, string>;
  statementIds: readonly string[];
}): GoldenGate {
  const score = scoreBreakdown(input.answers, input.statementIds);
  const errors = Object.keys(input.errors).length;
  const reasons: string[] = [];
  if (input.statementIds.length === 0) reasons.push('The rubric has no statements.');
  if (score.unanswered > 0) reasons.push(`${score.unanswered} statement(s) are not graded yet.`);
  if (errors > 0) reasons.push(`${errors} statement(s) failed to grade.`);
  if (score.no > 0) reasons.push(`${score.no} statement(s) grade No against the Golden output.`);
  const ok =
    input.statementIds.length > 0 && score.unanswered === 0 && errors === 0 && score.percent === GOLDEN_REQUIRED_PERCENT;
  return { ok, percent: score.percent, unanswered: score.unanswered, errors, reasons };
}

export function calibrationInBand(percent: number | null): boolean {
  return percent !== null && percent >= CALIBRATION_MIN_PERCENT && percent <= CALIBRATION_MAX_PERCENT;
}

export interface StabilityGate {
  ok: boolean;
  scores: number[];
  spread: number | null;
  repeatable: boolean;
  inBand: boolean;
  withinTolerance: boolean;
  complete: boolean;
  /** Statements whose verdict differs between passes. */
  flips: string[];
  reasons: string[];
}

export function stabilityGate(input: {
  passes: { answers: Record<string, Verdict>; errors: Record<string, string> }[];
  statementIds: readonly string[];
  calibrationPercent?: number | null;
  /**
   * Delivery (after review) also compares each pass to the human score.
   * First-instance preview has no human eval — band and spread only.
   */
  calibrationGateActive?: boolean;
}): StabilityGate {
  const calGate = input.calibrationGateActive === true;
  const reasons: string[] = [];
  const complete =
    input.passes.length === STABILITY_PASSES &&
    input.passes.every(
      (pass) =>
        Object.keys(pass.errors).length === 0 &&
        input.statementIds.every((id) => pass.answers[id] === true || pass.answers[id] === false),
    );
  const scores = input.passes.map((pass) => scoreBreakdown(pass.answers, input.statementIds).percent ?? 0);
  const spread = scores.length === 0 ? null : Math.max(...scores) - Math.min(...scores);
  const repeatable = complete && spread !== null && spread <= STABILITY_MAX_SPREAD_POINTS;
  const inBand = complete && scores.every((score) => calibrationInBand(score));
  const withinTolerance =
    !calGate ||
    (complete &&
      input.calibrationPercent != null &&
      scores.every((score) => Math.abs(score - input.calibrationPercent!) <= STABILITY_CALIBRATION_TOLERANCE_POINTS));
  const flips = complete
    ? input.statementIds.filter((id) => new Set(input.passes.map((pass) => pass.answers[id])).size > 1)
    : [];

  if (!complete) reasons.push(`Stability needs ${STABILITY_PASSES} complete passes with every statement graded.`);
  if (complete && !repeatable) reasons.push(`Pass scores must be within ${STABILITY_MAX_SPREAD_POINTS} points of each other.`);
  if (complete && !inBand) reasons.push(`Every pass must score between ${CALIBRATION_MIN_PERCENT}% and ${CALIBRATION_MAX_PERCENT}%.`);
  if (calGate && complete && input.calibrationPercent == null) reasons.push('A submitted human AI evaluation is required.');
  if (calGate && complete && input.calibrationPercent != null && !withinTolerance) {
    reasons.push(`Every pass must be within ${STABILITY_CALIBRATION_TOLERANCE_POINTS} points of the human AI score.`);
  }
  return {
    ok: complete && repeatable && inBand && withinTolerance,
    scores,
    spread,
    repeatable,
    inBand,
    withinTolerance,
    complete,
    flips,
    reasons,
  };
}

/** Before review: the latest Stability run must cover the current wording, be complete, and sit in band. */
export function stabilityReviewBlock(input: { passes: number; complete: boolean; inBand: boolean; stale: number }): string | null {
  if (input.passes === 0) return 'Run Stability before sending to review.';
  if (input.stale > 0) return `Run Stability again: ${input.stale} seat${input.stale === 1 ? '' : 's'} changed since the last run.`;
  if (!input.complete) return `Stability needs ${STABILITY_PASSES} complete passes with every seat graded.`;
  if (!input.inBand) return `Every Stability pass must score between ${CALIBRATION_MIN_PERCENT}% and ${CALIBRATION_MAX_PERCENT}% before sending to review.`;
  return null;
}

/** The handoff gates, exactly as the existing platform states them. */
export interface HandoffGates {
  golden: boolean;
  calibration: boolean;
  stability: boolean;
  reasons: string[];
}

export function handoffGates(input: {
  golden: GoldenGate | null;
  calibrationPercent: number | null;
  stability: StabilityGate | null;
  stabilityAccepted: boolean;
}): HandoffGates {
  const golden = input.golden?.ok === true;
  const calibration = calibrationInBand(input.calibrationPercent);
  const stability = input.stability?.ok === true && input.stabilityAccepted;
  const reasons: string[] = [];
  if (!golden) reasons.push('The effective Golden score must be 100%.');
  if (!calibration) reasons.push(`The human AI score must be between ${CALIBRATION_MIN_PERCENT}% and ${CALIBRATION_MAX_PERCENT}%.`);
  if (!stability) {
    reasons.push(
      `Three Stability scores must each be ${CALIBRATION_MIN_PERCENT}–${CALIBRATION_MAX_PERCENT}%, within ${STABILITY_MAX_SPREAD_POINTS} points of each other, within ${STABILITY_CALIBRATION_TOLERANCE_POINTS} points of the human AI score, and accepted.`,
    );
  }
  return { golden, calibration, stability, reasons };
}

export type HandoffTarget = 'ready_for_review' | 'bounced' | 'stability_pass' | 'final_review_pass';

/** After Stability is accepted, skip "mark ready" — confirm from the start of handoff. */
export function canConfirmStabilityPassFrom(status: string | null): boolean {
  return status === null || status === 'ready_for_review' || status === 'bounced';
}

/** After accept, another run would replace the handoff scores. Reopen before then. */
export function stabilityRerunAllowed(input: { acceptedAt: string | null }): boolean {
  return input.acceptedAt == null;
}

/** The score strip already stands in for handoff. Submit is available once every gate is closed. */
export function canSubmitToDataPlatform(input: {
  golden: boolean;
  calibration: boolean;
  stability: boolean;
  handoffStatus: string | null;
  pushedAt: string | null;
}): boolean {
  if (input.pushedAt) return false;
  if (!(input.golden && input.calibration && input.stability)) return false;
  return input.handoffStatus === 'stability_pass' || input.handoffStatus === 'final_review_pass';
}

export function handoffTransitionGate(target: HandoffTarget, gates: HandoffGates): { ok: true } | { ok: false; error: string } {
  if (target === 'bounced') return { ok: true };
  if (target === 'ready_for_review' && !gates.golden) {
    return { ok: false, error: gates.reasons[0] ?? 'Golden autorate is not ready.' };
  }
  if ((target === 'stability_pass' || target === 'final_review_pass') && !(gates.golden && gates.calibration && gates.stability)) {
    return { ok: false, error: gates.reasons.join(' ') };
  }
  return { ok: true };
}
