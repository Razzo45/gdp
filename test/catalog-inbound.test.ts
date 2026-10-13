import { describe, expect, it } from 'vitest';
import { boardWatchStatusIds, catalogIdsToPull, catalogLaneReopensSubmitted, parseProjectSubmissionList } from '@/domain/catalogInbound';
import { shouldEnqueueCatalogReturn } from '@/domain/catalogReturn';

const WORK = 'e-approved';
const HANDOFF = 'f-ready';
const REJECTED = 'd-rejected';
const DRAFT = 'a-draft';
const FINAL = 'h-final';
const REVISED = 'c-revised';

const statuses = [
  { statusId: DRAFT, name: 'A. Draft' },
  { statusId: WORK, name: 'E. Task and Golden Output Approved' },
  { statusId: HANDOFF, name: 'F. Ready for Expert Assignment' },
  { statusId: FINAL, name: 'H. Final Review' },
  { statusId: REVISED, name: 'C. Revised' },
  { statusId: REJECTED, name: 'D. Rejected' },
  { statusId: 'k-ready', name: 'K. Client-Ready' },
];

const transitions = [
  { from: WORK, to: HANDOFF, trigger: 'submit' },
  { from: HANDOFF, to: FINAL, trigger: 'approve' },
  { from: FINAL, to: 'k-ready', trigger: 'approve' },
  { from: FINAL, to: WORK, trigger: 'revise' },
  { from: HANDOFF, to: REVISED, trigger: 'revise' },
];

describe('boardWatchStatusIds', () => {
  it('watches inbound pickup and Catalog return destinations, not draft or rejected', () => {
    const watch = boardWatchStatusIds({
      workStatusId: WORK,
      handoffStatusId: HANDOFF,
      inboundStatusIds: [WORK, HANDOFF, FINAL],
      statuses,
      transitions,
    });
    expect([...watch].sort()).toEqual([REVISED, WORK].sort());
    expect(watch.has(DRAFT)).toBe(false);
    expect(watch.has(REJECTED)).toBe(false);
    expect(watch.has(HANDOFF)).toBe(false);
    expect(watch.has(FINAL)).toBe(false);
  });

  it('watches send-to-rubric back to E and revise-to-creator onto C from Final Review', () => {
    const watch = boardWatchStatusIds({
      workStatusId: WORK,
      handoffStatusId: HANDOFF,
      inboundStatusIds: [WORK],
      statuses,
      transitions: [
        ...transitions,
        { from: FINAL, to: WORK, trigger: 'send-to-rubric' },
        { from: FINAL, to: REVISED, trigger: 'revise-to-creator' },
      ],
    });
    expect(watch.has(WORK)).toBe(true);
    expect(watch.has(REVISED)).toBe(true);
    expect(watch.has(FINAL)).toBe(false);
  });
});

describe('catalogIdsToPull', () => {
  it('pulls watched rows we already have, and only recent new inbound', () => {
    const now = Date.parse('2026-10-13T10:00:00.000Z');
    expect(
      catalogIdsToPull(
        [
          { id: '907edd44-new', statusId: WORK, updatedAt: '2026-10-13T08:21:00.000Z' },
          { id: 'a002e716-back', statusId: WORK, updatedAt: '2026-09-30T10:00:00.000Z' },
          { id: 'old-inbound', statusId: WORK, updatedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'old-rejected', statusId: REJECTED, updatedAt: '2026-10-13T09:00:00.000Z' },
        ],
        new Set([WORK.toLowerCase()]),
        new Set(['a002e716-back']),
        now,
      ),
    ).toEqual(['907edd44-new', 'a002e716-back']);
  });
});

describe('parseProjectSubmissionList', () => {
  it('reads Catalog list ids, current status, and pagination', () => {
    const parsed = parseProjectSubmissionList({
      data: [
        { projectSubmissionId: '907edd44-7fb4-4d36-bf46-8c5e2089ada1', workflowState: { statusId: WORK } },
        { projectSubmissionId: 'skip-me', workflowState: {} },
      ],
      metadata: { pagination: { page: 1, totalPages: 2 } },
    });
    expect(parsed).toEqual({
      page: 1,
      totalPages: 2,
      submissions: [
        { id: '907edd44-7fb4-4d36-bf46-8c5e2089ada1', statusId: WORK, updatedAt: null },
        { id: 'skip-me', statusId: null, updatedAt: null },
      ],
    });
  });
});

describe('catalogLaneReopensSubmitted', () => {
  it('treats pickup and explicit platform return as a bounce', () => {
    expect(catalogLaneReopensSubmitted('platform_return')).toBe(true);
    expect(catalogLaneReopensSubmitted('unassigned')).toBe(true);
    expect(catalogLaneReopensSubmitted('preparing')).toBe(true);
    expect(catalogLaneReopensSubmitted('submitted')).toBe(false);
    expect(catalogLaneReopensSubmitted('unknown')).toBe(false);
  });
});

describe('shouldEnqueueCatalogReturn', () => {
  it('applies when a submitted task is back on inbound pickup', () => {
    expect(
      shouldEnqueueCatalogReturn({
        stage: 'done',
        handoffStatus: 'client_visible',
        catalogLane: 'unassigned',
        catalogStatusId: WORK,
        existing: null,
        previousStatusId: 'h-final',
      }),
    ).toBe(true);
    expect(
      shouldEnqueueCatalogReturn({
        stage: 'done',
        handoffStatus: 'client_visible',
        catalogLane: 'unassigned',
        catalogStatusId: WORK,
        existing: null,
        previousStatusId: WORK,
      }),
    ).toBe(false);
  });
});
