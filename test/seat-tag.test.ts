import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RubricStatement } from '@/db/schema';
import type { SubmissionView } from '@/lib/services/view';

vi.mock('@/components/task/scrollTask', () => ({
  scrollTaskPanel: vi.fn(),
  TASK_SCROLL_ATTR: 'data-task-scroll',
}));

import { RubricEditor } from '@/components/task/RubricEditor';

function statement(partial: Partial<RubricStatement> & Pick<RubricStatement, 'id' | 'family' | 'tag' | 'statement'>): RubricStatement {
  return {
    rubricId: 'r1',
    position: 1,
    notes: '',
    scope: 'output',
    inputFileIds: [],
    outputFile: null,
    claimKey: null,
    origin: 'manual',
    lint: null,
    updatedBy: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as RubricStatement;
}

function view(statements: RubricStatement[], can: Partial<SubmissionView['can']> = {}): SubmissionView {
  return {
    submission: { id: 's1', stage: 'rubric', catalogSubmissionId: 'abcdef12-xxxx' } as SubmissionView['submission'],
    brief: { goldenFiles: [], inputFiles: [], hasAcceptanceCriteria: false } as unknown as SubmissionView['brief'],
    people: {},
    rubric: {
      id: 'r1',
      version: 1,
      revision: 1,
      seeds: [],
      generation: {},
      statements,
      quotas: { format: 5, content: 15, visual: 30 },
      target: 50,
    },
    golden: null,
    stability: null,
    review: { latest: null, submittedPercent: null, feedback: [] },
    handoff: { gates: { golden: false, calibration: false, stability: false, reasons: [] }, goldenPercent: null, calibrationPercent: null, stabilityScores: null },
    aiOutputs: [],
    jobs: [],
    helper: null,
    events: [],
    catalogReturnNote: null,
    can: {
      lens: 'rubric',
      editRubric: true,
      holdsRubricSeat: true,
      openRubric: false,
      openStability: false,
      runStability: true,
      runGolden: true,
      review: false,
      control: false,
      claimRubric: false,
      claimReview: false,
      push: false,
      seeHistory: false,
      seeJobsLog: false,
      seeRunProgress: true,
      seeReviewPanel: false,
      seeRubricEditor: true,
      seeGoldenFiles: true,
      seeStability: true,
      seeHandoff: false,
      seeAiUpload: true,
      seeScoreGolden: true,
      seeScoreStability: true,
      changeAiOutputs: true,
      ...can,
    },
  } as unknown as SubmissionView;
}

const formatSeat = statement({
  id: '11111111-1111-1111-1111-111111111111',
  family: 'format',
  tag: 'Format/File',
  statement: 'The delivered file is a PDF with embedded fonts.',
});
const craftSeat = statement({
  id: '22222222-2222-2222-2222-222222222222',
  family: 'visual',
  tag: 'Craft - Branding',
  statement: 'The wordmark uses the published Rowan serif on every board.',
});

const panel = (v: SubmissionView) => ({
  view: v,
  actorId: 'tester',
  refresh: async () => undefined,
  notify: () => undefined,
});

describe('seat tag dropdown', () => {
  it('lets an editor change the tag on a seated statement', () => {
    const html = renderToStaticMarkup(
      createElement(RubricEditor, panel(view([formatSeat, craftSeat]))),
    );
    expect(html).toMatch(/<select[^>]*aria-label="Tag"[^>]*>/);
    expect(html).toContain('<option value="Format/File" selected="">Format/File</option>');
    expect(html).toContain('<option value="Content - Exact">Content - Exact</option>');
    expect(html).toContain('<option value="Craft - Composition">Craft - Composition</option>');
  });

  it('puts a compact tag pill on the action row, after Delete and after the statement', () => {
    const html = renderToStaticMarkup(
      createElement(RubricEditor, panel(view([formatSeat, craftSeat]))),
    );
    const statementAt = html.indexOf('The delivered file is a PDF with embedded fonts.');
    const deleteAt = html.indexOf('>Delete<');
    const selectAt = html.search(/<select[^>]*aria-label="Tag"/);
    const reassessAt = html.indexOf('>Reassess<');
    expect(statementAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(statementAt);
    expect(selectAt).toBeGreaterThan(deleteAt);
    expect(reassessAt).toBeGreaterThan(selectAt);
    expect(html).toMatch(/seat-pill[^>]*>[\s\S]*<select[^>]*aria-label="Tag"/);
    expect(html).not.toMatch(/>Tag<\/span>/);
  });

  it('warns that an off-quota mix cannot be sent to review', () => {
    const html = renderToStaticMarkup(
      createElement(RubricEditor, panel(view([formatSeat, craftSeat]))),
    );
    expect(html).toMatch(/cannot be sent to review/i);
    expect(html).toMatch(/5 Format, 15 Content, 30 Craft/i);
  });

  it('shows the tag as text when the rubric is read-only', () => {
    const html = renderToStaticMarkup(
      createElement(RubricEditor, panel(view([formatSeat], { editRubric: false }))),
    );
    const statementAt = html.indexOf('The delivered file is a PDF with embedded fonts.');
    const tagAt = html.search(/data-seat-tag="Format\/File"/);
    expect(statementAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(statementAt);
    expect(html).not.toMatch(/<select[^>]*aria-label="Tag"/);
  });
});
