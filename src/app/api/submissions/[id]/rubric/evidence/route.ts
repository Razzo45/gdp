import { NextResponse } from 'next/server';
import { route } from '@/lib/api';
import { submissionView } from '@/lib/services/view';

export const dynamic = 'force-dynamic';

/**
 * "Download evidence JSON": the rubric with every grade and its evidence,
 * the human AI evaluation and the stability passes, as one file. Built from
 * the same view the page renders, so it never says something the page does
 * not; raw Catalog payloads and other people's identities stay out.
 */
export const GET = route({}, async ({ actor, params }) => {
  const view = await submissionView(actor, params['id']!);
  const statements = view.rubric?.statements ?? [];
  const pack = {
    exportedAt: new Date().toISOString(),
    submission: { id: view.submission.id, catalogSubmissionId: view.submission.catalogSubmissionId, project: view.brief.projectName, title: view.submission.title, stage: view.submission.stage },
    rubric: view.rubric ? { id: view.rubric.id, version: view.rubric.version, revision: view.rubric.revision, seeds: view.rubric.seeds } : null,
    gates: { golden: view.golden?.gate ?? null, calibrationPercent: view.handoff.calibrationPercent, stability: view.stability?.gate ?? null, handoff: view.handoff.gates },
    statements: statements.map((s, index) => ({
      id: s.id,
      n: index + 1,
      family: s.family,
      tag: s.tag,
      statement: s.statement,
      notes: s.notes,
      scope: s.scope,
      inputFileIds: s.inputFileIds,
      origin: s.origin,
      lint: s.lint,
      golden: view.golden ? { verdict: view.golden.verdicts[s.id] ?? null, source: view.golden.sources[s.id] ?? null, evidence: view.golden.evidence[s.id] ?? '', error: view.golden.errors[s.id] ?? null } : null,
      humanAiEval: view.review.latest ? { answer: view.review.latest.answers[s.id] ?? null, evidence: view.review.latest.evidence[s.id] ?? '' } : null,
      stability: (view.stability?.passes ?? []).map((p) => ({ pass: p.passIndex, answer: p.answers[s.id] ?? null, evidence: p.evidence[s.id] ?? '', error: p.errors[s.id] ?? null })),
    })),
    stability: view.stability ? { groupId: view.stability.groupId, scores: view.stability.passes.map((p) => p.scorePercent), acceptedAt: view.stability.acceptedAt, flips: view.stability.gate?.flips ?? [] } : null,
    reviewDecisions: view.review.feedback,
  };
  const name = `rubric-evidence-${view.submission.catalogSubmissionId.slice(0, 8)}-v${view.rubric?.version ?? 0}.json`;
  return new NextResponse(JSON.stringify(pack, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  });
});
