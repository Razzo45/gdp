import { describe, expect, it } from 'vitest';
import { jobProgressView, statusFromView, statusKey } from '@/domain/freshness';

const base = {
  stage: 'rubric',
  reviewStatus: null,
  handoffStatus: null,
  rubricAssigneeId: 'ana',
  reviewerId: null,
  revision: 1,
  jobs: [{ id: 'j1', status: 'running' }],
};

describe('statusKey', () => {
  it('is stable for the same pulse', () => {
    expect(statusKey(base)).toBe(statusKey({ ...base, jobs: [...base.jobs] }));
  });

  it('changes when a job finishes or the stage moves', () => {
    expect(statusKey({ ...base, jobs: [{ id: 'j1', status: 'succeeded' }] })).not.toBe(statusKey(base));
    expect(statusKey({ ...base, stage: 'review' })).not.toBe(statusKey(base));
    expect(statusKey({ ...base, reviewerId: 'rita' })).not.toBe(statusKey(base));
  });

  it('changes when a running job reports new progress', () => {
    expect(
      statusKey({
        ...base,
        jobs: [{ id: 'j1', status: 'running', progressKey: 'Pass 1 done (42.0%)' }],
      }),
    ).not.toBe(statusKey(base));
  });

  it('reads the same shape off a task view', () => {
    expect(statusKey(statusFromView({ submission: base, jobs: base.jobs }))).toBe(statusKey(base));
  });
});

describe('jobProgressView', () => {
  it('shows golden prepare progress before any seat is graded', () => {
    expect(
      jobProgressView({
        kind: 'golden_autorate',
        status: 'running',
        progress: { done: 0, total: 50, note: 'Preparing brief.pdf' },
      }),
    ).toEqual({
      title: 'Preparing brief.pdf',
      ratio: 0,
      detail: '0 of 50 seats',
    });
  });

  it('moves the golden bar as seats land', () => {
    expect(
      jobProgressView({
        kind: 'golden_autorate',
        status: 'running',
        progress: { done: 12, total: 50, note: 'Grading 12 of 50 seats' },
      }),
    ).toEqual({
      title: 'Grading 12 of 50 seats',
      ratio: 0.24,
      detail: '12 of 50 seats',
    });
  });
});
