import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubmissionView } from "@/lib/services/view";

vi.mock("@/components/task/scrollTask", () => ({
  scrollTaskPanel: vi.fn(),
  TASK_SCROLL_ATTR: "data-task-scroll",
}));

import { ScoreStrip } from "@/components/ScoreStrip";

function view(partial: Partial<SubmissionView["can"]> & { jobs?: SubmissionView["jobs"] } = {}): SubmissionView {
  return {
    submission: { id: "s1", stage: "rubric", catalogSubmissionId: "abcdef12-xxxx" } as SubmissionView["submission"],
    brief: {} as SubmissionView["brief"],
    people: {},
    rubric: null,
    golden: { gate: { ok: false, percent: 80, unanswered: 2, errors: 0, reasons: [] }, verdicts: {}, evidence: {}, errors: {}, sources: {}, audit: {} },
    stability: {
      gate: { ok: false, complete: false, inBand: false, withinTolerance: false, spread: null },
      passes: [],
      acceptedAt: null,
      groupId: null,
      calibrationGateActive: false,
      flipNotes: [],
    },
    review: { latest: null, submittedPercent: null, feedback: [] },
    handoff: {
      gates: { golden: false, calibration: false, stability: false, reasons: [] },
      goldenPercent: 80,
      calibrationPercent: null,
      stabilityScores: null,
    },
    aiOutputs: [],
    jobs: partial.jobs ?? [],
    helper: null,
    events: [],
    catalogReturnNote: null,
    can: {
      lens: "controller",
      editRubric: true,
      holdsRubricSeat: true,
      openRubric: false,
      openStability: false,
      runStability: true,
      runGolden: true,
      review: false,
      control: true,
      claimRubric: false,
      claimReview: false,
      push: false,
      seeHistory: true,
      seeJobsLog: true,
      seeRunProgress: true,
      seeReviewPanel: true,
      seeRubricEditor: true,
      seeGoldenFiles: true,
      seeStability: true,
      seeHandoff: true,
      seeAiUpload: true,
      seeScoreGolden: true,
      seeScoreStability: true,
      ...partial,
    },
  } as unknown as SubmissionView;
}

describe("ScoreStrip clickability markup", () => {
  it("renders Golden, AI Score, and Stability as buttons for PM/review visibility", () => {
    const html = renderToStaticMarkup(createElement(ScoreStrip, { view: view() }));
    expect(html).toContain(">Golden<");
    expect(html).toContain(">AI Score<");
    expect(html).toContain(">Stability<");
    expect((html.match(/type="button"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps AI Score visible without a jump for rubric-only users", () => {
    const html = renderToStaticMarkup(
      createElement(ScoreStrip, {
        view: view({ lens: "rubric", seeReviewPanel: false, seeScoreGolden: true, seeScoreStability: true, control: false }),
      }),
    );
    expect(html).toContain(">AI Score<");
    expect(html).toContain(">Golden<");
    expect(html).toContain(">Stability<");
  });

  it("adds View progress outside the jump control when a golden job is running", () => {
    const html = renderToStaticMarkup(
      createElement(ScoreStrip, {
        view: view({
          jobs: [{ id: "j1", kind: "golden_autorate", status: "running", progress: {}, error: null, createdAt: "", startedAt: null, finishedAt: null, attempts: 1 }],
        }),
        onOpenJobs: () => undefined,
      }),
    );
    expect(html).toContain("View progress");
    // Progress is a sibling after the jump button closes — not nested inside it.
    expect(html).toMatch(/<\/button><button type="button"[^>]*>View progress<\/button>/);
  });

  it("compact badges stay clickable without nesting", () => {
    const html = renderToStaticMarkup(createElement(ScoreStrip, { view: view(), compact: true }));
    expect(html).toContain('type="button"');
    expect(html).toContain(">Golden 80%<");
    expect(html).toContain(">Stability —<");
    expect(html).not.toMatch(/<button\b[^>]*>[^<]*<button\b/);
  });
});
