import { describe, expect, it } from 'vitest';
import { isHandleExpired, reapableShas } from '@/domain/reaper';

const now = Date.parse('2026-10-10T10:00:00Z');
const later = new Date(now + 40 * 60 * 60_000).toISOString();
const soon = new Date(now + 5 * 60_000).toISOString();

describe('reapableShas', () => {
  it('keeps a live handle while any using task is still grading', () => {
    expect(
      reapableShas({
        files: [{ sha256: 'v', expiresAt: later }],
        uses: [{ sha256: 'v', submissionId: 'a' }],
        stages: [{ id: 'a', stage: 'rubric' }],
        busySubmissionIds: [],
        nowMs: now,
      }),
    ).toEqual([]);
  });

  it('culls when every using task has finished grading', () => {
    expect(
      reapableShas({
        files: [{ sha256: 'v', expiresAt: later }],
        uses: [
          { sha256: 'v', submissionId: 'a' },
          { sha256: 'v', submissionId: 'b' },
        ],
        stages: [
          { id: 'a', stage: 'handoff' },
          { id: 'b', stage: 'done' },
        ],
        busySubmissionIds: [],
        nowMs: now,
      }),
    ).toEqual(['v']);
  });

  it('keeps a finished-task handle if another live task still uses the same sha', () => {
    expect(
      reapableShas({
        files: [{ sha256: 'v', expiresAt: later }],
        uses: [
          { sha256: 'v', submissionId: 'done-task' },
          { sha256: 'v', submissionId: 'live-task' },
        ],
        stages: [
          { id: 'done-task', stage: 'done' },
          { id: 'live-task', stage: 'stability' },
        ],
        busySubmissionIds: [],
        nowMs: now,
      }),
    ).toEqual([]);
  });

  it('waits for in-flight jobs on a finished task before culling', () => {
    expect(
      reapableShas({
        files: [{ sha256: 'v', expiresAt: later }],
        uses: [{ sha256: 'v', submissionId: 'a' }],
        stages: [{ id: 'a', stage: 'handoff' }],
        busySubmissionIds: ['a'],
        nowMs: now,
      }),
    ).toEqual([]);
  });

  it('culls expired handles even when a task is still live, and ignores unexpired orphans', () => {
    expect(isHandleExpired(soon, now)).toBe(true);
    expect(
      reapableShas({
        files: [
          { sha256: 'old', expiresAt: soon },
          { sha256: 'orphan', expiresAt: later },
        ],
        uses: [],
        stages: [{ id: 'a', stage: 'rubric' }],
        busySubmissionIds: [],
        nowMs: now,
      }),
    ).toEqual(['old']);
  });
});
