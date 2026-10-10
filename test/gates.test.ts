import { describe, expect, it } from 'vitest';
import { calibrationInBand, goldenGate, handoffGates, handoffTransitionGate, scoreBreakdown, stabilityGate } from '@/domain/gates';

const ids = ['a', 'b', 'c', 'd', 'e'];
const all = (v: boolean) => Object.fromEntries(ids.map((id) => [id, v]));

describe('scoreBreakdown', () => {
  it('ignores unanswered statements in the percentage', () => {
    const s = scoreBreakdown({ a: true, b: false, c: null }, ids);
    expect(s).toMatchObject({ yes: 1, no: 1, unanswered: 3, total: 5, percent: 50 });
  });
  it('is null when nothing is graded', () => {
    expect(scoreBreakdown({}, ids).percent).toBeNull();
  });
});

describe('goldenGate', () => {
  it('passes only at 100% with every statement graded and no errors', () => {
    expect(goldenGate({ answers: all(true), errors: {}, statementIds: ids }).ok).toBe(true);
    expect(goldenGate({ answers: { ...all(true), c: false }, errors: {}, statementIds: ids }).ok).toBe(false);
    expect(goldenGate({ answers: { ...all(true), c: null }, errors: {}, statementIds: ids }).ok).toBe(false);
    expect(goldenGate({ answers: all(true), errors: { a: 'timeout' }, statementIds: ids }).ok).toBe(false);
    expect(goldenGate({ answers: {}, errors: {}, statementIds: [] }).ok).toBe(false);
  });
});

describe('calibrationInBand', () => {
  it('is inclusive at both ends', () => {
    expect(calibrationInBand(20)).toBe(true);
    expect(calibrationInBand(50)).toBe(true);
    expect(calibrationInBand(19.9)).toBe(false);
    expect(calibrationInBand(50.1)).toBe(false);
    expect(calibrationInBand(null)).toBe(false);
  });
});

describe('stabilityGate', () => {
  const pass = (yes: number) => ({ answers: Object.fromEntries(ids.map((id, i) => [id, i < yes])), errors: {} });

  it('requires three complete passes', () => {
    const g = stabilityGate({ passes: [pass(2), pass(2)], statementIds: ids, calibrationPercent: 40 });
    expect(g.complete).toBe(false);
    expect(g.ok).toBe(false);
  });

  it('passes when spread ≤ 5 and every pass within 20 of calibration', () => {
    const g = stabilityGate({ passes: [pass(2), pass(2), pass(2)], statementIds: ids, calibrationPercent: 40 });
    expect(g).toMatchObject({ ok: true, spread: 0, repeatable: true, withinTolerance: true, flips: [] });
  });

  it('fails on spread over 5 and reports flips', () => {
    const g = stabilityGate({ passes: [pass(2), pass(3), pass(2)], statementIds: ids, calibrationPercent: 40 });
    expect(g.spread).toBe(20);
    expect(g.repeatable).toBe(false);
    expect(g.ok).toBe(false);
    expect(g.flips).toEqual(['c']);
  });

  it('fails when a pass is more than 20 points from the human score', () => {
    const g = stabilityGate({ passes: [pass(4), pass(4), pass(4)], statementIds: ids, calibrationPercent: 40 });
    expect(g.repeatable).toBe(true);
    expect(g.withinTolerance).toBe(false);
    expect(g.ok).toBe(false);
  });

  it('fails without a submitted calibration when the official gate is on', () => {
    const g = stabilityGate({ passes: [pass(2), pass(2), pass(2)], statementIds: ids, calibrationPercent: null });
    expect(g.ok).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/human AI evaluation/);
  });

  it('lets the rubric team preview repeatability before review (no human score)', () => {
    const g = stabilityGate({ passes: [pass(2), pass(2), pass(2)], statementIds: ids, calibrationPercent: null, calibrationGateActive: false });
    expect(g).toMatchObject({ ok: true, repeatable: true, withinTolerance: true });
    expect(g.reasons.join(' ')).not.toMatch(/human AI evaluation/);
  });

  it('treats an errored statement as incomplete', () => {
    const broken = { ...pass(2), errors: { a: 'rate limit' } };
    expect(stabilityGate({ passes: [broken, pass(2), pass(2)], statementIds: ids, calibrationPercent: 40 }).complete).toBe(false);
  });
});

describe('handoff', () => {
  const golden = goldenGate({ answers: all(true), errors: {}, statementIds: ids });
  const stability = stabilityGate({ passes: Array(3).fill({ answers: { a: true, b: true, c: false, d: false, e: false }, errors: {} }), statementIds: ids, calibrationPercent: 40 });

  it('needs stability to be explicitly accepted', () => {
    expect(handoffGates({ golden, calibrationPercent: 40, stability, stabilityAccepted: false }).stability).toBe(false);
    expect(handoffGates({ golden, calibrationPercent: 40, stability, stabilityAccepted: true }).stability).toBe(true);
  });

  it('gates the ladder', () => {
    const open = handoffGates({ golden: null, calibrationPercent: null, stability: null, stabilityAccepted: false });
    const closed = handoffGates({ golden, calibrationPercent: 40, stability, stabilityAccepted: true });
    expect(handoffTransitionGate('bounced', open).ok).toBe(true);
    expect(handoffTransitionGate('ready_for_review', open).ok).toBe(false);
    expect(handoffTransitionGate('stability_pass', open).ok).toBe(false);
    expect(handoffTransitionGate('final_review_pass', closed).ok).toBe(true);
  });
});
