import './env';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { keepCatalogId } from '@/domain/cutoverKeep';
import {
  assignmentSeat,
  factoryStatementsFromLegacy,
  inferLegacyPipeline,
  latestLegacyRun,
  mapLegacySeatIds,
  remapEvidence,
  remapVerdicts,
  stabilityGroupsFromAutorate,
  type LegacyReviewStatus,
} from '@/domain/legacyImport';
import { WORK_STATE_LABEL, workStateOf } from '@/domain/workState';
import { readCatalogSubmission } from '@/lib/catalog/read';

const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

function load(name: string): Record<string, unknown>[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function latestReview(internalId: string): LegacyReviewStatus | null {
  const rows = load('public.wirestock_submission_reviews.json')
    .filter((row) => str(row, 'submission_id') === internalId)
    .sort((a, b) => str(b, 'updated_at', 'created_at').localeCompare(str(a, 'updated_at', 'created_at')));
  const status = str(rows[0] ?? {}, 'status').toLowerCase();
  if (status === 'pending' || status === 'approved' || status === 'changes_requested') return status;
  return null;
}

function main(): void {
  const subs = load('public.wirestock_submissions.json');
  const runs = load('public.wirestock_rubric_runs.json');
  const answers = load('public.wirestock_rubric_answers.json');
  const assignments = load('public.wirestock_submission_assignments.json');
  const reviews = load('public.wirestock_submission_reviews.json');
  const watches = new Map(load('public.watched_projects.json').map((row) => [str(row, 'project_id'), row]));
  const people = new Map(load('public.profiles.json').map((row) => [str(row, 'id'), str(row, 'email')]));

  const runsByInternal = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) {
    const id = str(run, 'submission_id');
    const list = runsByInternal.get(id) ?? [];
    list.push(run);
    runsByInternal.set(id, list);
  }

  const wanted = subs.filter((row) => keepCatalogId(str(row, 'submission_id')));
  const missing = 29 - wanted.length;
  const rows = wanted.map((sub) => {
    const internal = str(sub, 'id');
    const catalogId = str(sub, 'submission_id');
    const watch = watches.get(str(sub, 'project_id'));
    const read = readCatalogSubmission(sub['submission'], sub['project']);
    const latest = latestLegacyRun(runsByInternal.get(internal) ?? []);
    const factory = factoryStatementsFromLegacy(latest?.['rows']);
    const imported = factory.map((row, index) => ({ id: `new-${index}`, statement: row.statement, claimKey: row.claimKey }));
    const seats = latest ? mapLegacySeatIds((latest['rows'] as { id?: unknown; statement?: unknown }[]) ?? [], imported) : new Map<string, string>();
    const runIds = new Set((runsByInternal.get(internal) ?? []).map((row) => str(row, 'id')));
    const answerRows = answers.filter((row) => runIds.has(str(row, 'run_id')));
    let golden = 0;
    let goldenEvidence = 0;
    let human = 0;
    let cal = 0;
    let calEvidence = 0;
    for (const row of answerRows) {
      const mapped = remapVerdicts(rec(row['answers']), seats);
      const evidence = remapEvidence(rec(row['evidence']), seats);
      golden += Object.keys(mapped).length;
      goldenEvidence += Object.keys(evidence).length;
      const sources = rec(row['sources']);
      for (const [legacyId, source] of Object.entries(sources)) {
        if (String(source) === 'human' && seats.has(legacyId)) human += 1;
      }
      cal += Object.keys(remapVerdicts(rec(row['calibration_answers']), seats)).length;
      calEvidence += Object.keys(remapEvidence(rec(row['calibration_evidence']), seats)).length;
    }
    const newestAnswers = answers.find((row) => str(row, 'run_id') === str(latest ?? {}, 'id'));
    const stabGroups = stabilityGroupsFromAutorate(newestAnswers?.['autorate_runs'], newestAnswers?.['questions']);
    let stabPasses = 0;
    let stabVerdicts = 0;
    let stabEvidence = 0;
    let stabAccepted = 0;
    const stabGroupIds: string[] = [];
    for (const group of stabGroups) {
      stabGroupIds.push(group.group_id.slice(0, 8) + (group.parent_group_id ? `←${group.parent_group_id.slice(0, 8)}` : ''));
      if (group.accepted_at) stabAccepted += 1;
      stabPasses += group.runs.length;
      for (const pass of group.runs) {
        const mapped = remapVerdicts(Object.keys(pass.answers).length ? pass.answers : pass.grades, seats);
        const evidence = remapEvidence(Object.keys(pass.evidence).length ? pass.evidence : pass.grades, seats);
        stabVerdicts += Object.keys(mapped).length;
        stabEvidence += Object.keys(evidence).length;
      }
    }
    const seatAssign = { rubric: null as string | null, review: null as string | null };
    for (const raw of assignments.filter((row) => str(row, 'submission_id') === internal)) {
      const seat = assignmentSeat(str(raw, 'team_role_key'));
      const who = people.get(str(raw, 'assignee_id')) ?? str(raw, 'assignee_id');
      if (seat && who) seatAssign[seat] = who;
    }
    const review = reviews
      .filter((row) => str(row, 'submission_id') === internal)
      .sort((a, b) => str(b, 'updated_at', 'created_at').localeCompare(str(a, 'updated_at', 'created_at')))[0];
    const reviewer = people.get(str(review ?? {}, 'reviewer_assignee_id')) || str(review ?? {}, 'reviewer_assignee_id') || null;
    const reviewStatus = latestReview(internal);
    const project = rec(sub['project']);
    const workflow = rec(project['workflow']);
    const pipeline = inferLegacyPipeline({
      catalogStatusId: read?.statusId ?? null,
      catalogStatusName: read?.statusName ?? null,
      workStatusId: str(watch ?? {}, 'work_status_id') || null,
      handoffStatusId: str(watch ?? {}, 'handoff_status_id') || null,
      listStatusIds: Array.isArray(watch?.['status_ids']) ? (watch?.['status_ids'] as string[]) : [],
      catalogStatuses: workflow['statuses'],
      catalogTransitions: workflow['transitions'],
      reviewStatus,
      hasAssignee: Boolean(seatAssign.rubric),
      assigned: Boolean(seatAssign.rubric || seatAssign.review),
    });
    const board = workStateOf({
      stage: pipeline.stage,
      rubricAssigneeId: seatAssign.rubric,
      reviewStatus: pipeline.reviewStatus,
      handoffStatus: pipeline.handoffStatus,
    });
    const gaps: string[] = [];
    if (factory.length === 0 && board !== 'unassigned' && board !== 'other') gaps.push('no rubric on live');
    if (factory.length && seats.size < factory.length) gaps.push(`remap ${seats.size}/${factory.length}`);
    if (factory.length && golden === 0 && board !== 'unassigned') gaps.push('no golden verdicts');
    if (golden && goldenEvidence === 0) gaps.push('golden verdicts without evidence (empty on live)');
    if (reviewStatus && cal === 0) gaps.push('review exists but no human eval answers');
    if (board === 'stability' && stabPasses === 0) gaps.push('Approved on board but no attachable Stability group');
    return {
      short: catalogId.slice(0, 8),
      catalogId,
      catalogStatus: read?.statusName ?? '(none)',
      landsAs: WORK_STATE_LABEL[board],
      rubric: seatAssign.rubric,
      review: seatAssign.review || reviewer,
      statements: factory.length,
      seats: seats.size,
      golden,
      goldenEvidence,
      humanOverrides: human,
      cal,
      calEvidence,
      stabPasses,
      stabVerdicts,
      stabEvidence,
      stabAccepted,
      stabGroups: stabGroupIds,
      gaps,
    };
  });

  rows.sort((a, b) => a.short.localeCompare(b.short));
  console.log(`Keep-set rehearsal: ${rows.length} snapshot matches, ${missing} prefixes not in snapshot`);
  console.log(JSON.stringify(rows, null, 2));
}

main();
