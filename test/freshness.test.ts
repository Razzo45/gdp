import { describe, expect, it } from 'vitest';
import { statusFromView, statusKey } from '@/domain/freshness';

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

  it('reads the same shape off a task view', () => {
    expect(statusKey(statusFromView({ submission: base, jobs: base.jobs }))).toBe(statusKey(base));
  });
});
