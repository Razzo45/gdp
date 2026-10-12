import { classifyCatalogListState, pipelineFromListState } from './catalogListState';
import { lintStatement, toAffirmativeStatement } from './lint';
import { correctTag, FAMILIES, familyOfStatement, familyOfTag, isRubricTag, type Family, type RubricTag } from './rubric';

export type LegacyAppRole = 'admin' | 'pm' | 'rubric_creator' | 'reviewer';
export type LegacyAppStage = 'rubric' | 'review' | 'stability' | 'handoff' | 'done' | 'parked';
export type LegacyReviewStatus = 'pending' | 'approved' | 'changes_requested';
export type LegacyHandoffStatus = 'ready_for_review' | 'bounced' | 'stability_pass' | 'final_review_pass' | 'client_visible';

export interface LegacyPipelineInput {
  catalogStatusId?: string | null;
  catalogStatusName?: string | null;
  workStatusId?: string | null;
  handoffStatusId?: string | null;
  listStatusIds?: readonly string[] | null;
  catalogStatuses?: unknown;
  catalogTransitions?: unknown;
  gdpState?: string | null;
  reviewStatus?: LegacyReviewStatus | null;
  handoffStatus?: string | null;
  hasAssignee?: boolean;
  assigned?: boolean;
  sourceUnavailable?: boolean;
  observedStatusId?: string | null;
}

export interface LegacyPipeline {
  stage: LegacyAppStage;
  reviewStatus: LegacyReviewStatus | null;
  handoffStatus: LegacyHandoffStatus | null;
}

export function catalogLooksSubmitted(name?: string | null, statusId?: string | null, handoffStatusId?: string | null): boolean {
  if (statusId && handoffStatusId && statusId === handoffStatusId) return true;
  return /submit|independent expert|client[- _]?ready|final review/i.test(name ?? '');
}

export function catalogLooksReturned(name?: string | null): boolean {
  return /platform returned|bounced/i.test(name ?? '');
}

/** Later Catalog phases that live shows as Other, even when they are the configured work status. */
export function catalogLooksParkedPhase(name?: string | null): boolean {
  return /task and golden|client[- _]?ready|task draft|creator draft|\bF\.|ready for golden output|ready for review/i.test(name ?? '');
}

export function catalogLooksInReview(name?: string | null): boolean {
  return /ready for review/i.test(name ?? '');
}

export function inferLegacyPipeline(input: LegacyPipelineInput): LegacyPipeline {
  if (input.handoffStatus === 'bounced' || catalogLooksReturned(input.catalogStatusName)) {
    return { stage: 'handoff', reviewStatus: input.reviewStatus ?? 'approved', handoffStatus: 'bounced' };
  }
  const lane = classifyCatalogListState({
    statusId: input.observedStatusId ?? input.catalogStatusId ?? null,
    workStatusId: input.workStatusId ?? undefined,
    handoffStatusId: input.handoffStatusId ?? undefined,
    statuses: input.catalogStatuses ?? [],
    transitions: input.catalogTransitions ?? [],
    reviewStatus: input.reviewStatus,
    assigned: input.assigned ?? input.hasAssignee,
    sourceUnavailable: input.sourceUnavailable,
  });
  return pipelineFromListState(lane, input.reviewStatus ?? null);
}

export const LEGACY_ROLE_MAP: Record<string, LegacyAppRole> = {
  full_access: 'admin',
  admin: 'admin',
  users_manage: 'admin',
  'users.manage': 'admin',
  submissions_control: 'pm',
  'submissions.control': 'pm',
  pm: 'pm',
  project_manager: 'pm',
  rubric_team: 'rubric_creator',
  rubric_creator: 'rubric_creator',
  creator: 'rubric_creator',
  rubrics: 'rubric_creator',
  sme: 'rubric_creator',
  experts: 'rubric_creator',
  independent_expert: 'rubric_creator',
  review_team: 'reviewer',
  rubric_reviewer: 'reviewer',
  reviewer: 'reviewer',
  reviewers: 'reviewer',
};

export function mapLegacyRoles(keys: readonly string[]): LegacyAppRole[] {
  const roles = new Set<LegacyAppRole>();
  for (const raw of keys) {
    const key = raw.trim().toLowerCase().replace(/\s+/g, '_');
    const mapped = LEGACY_ROLE_MAP[key] ?? LEGACY_ROLE_MAP[raw.trim()];
    if (mapped) roles.add(mapped);
    else if (/admin|full_access|users\.manage/.test(key)) roles.add('admin');
    else if (/control|\bpm\b|project/.test(key)) roles.add('pm');
    else if (/rubric|creator/.test(key)) roles.add('rubric_creator');
    else if (/review/.test(key)) roles.add('reviewer');
  }
  return [...roles];
}

export function mapLegacyStage(state: string | null | undefined): LegacyAppStage {
  switch ((state ?? '').toLowerCase()) {
    case 'in_review':
      return 'review';
    case 'approved':
    case 'accepted':
      return 'stability';
    case 'submitted':
      return 'handoff';
    default:
      return 'rubric';
  }
}

export interface LegacyRubricRow {
  tag: string;
  statement: string;
  notes: string;
  family: Family;
  claimKey: string;
}

export function parseLegacyRubricRows(rows: unknown): LegacyRubricRow[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: LegacyRubricRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const statement = toAffirmativeStatement(String(row.statement ?? row.text ?? row.question ?? '')).slice(0, 600);
    if (statement.length < 8) continue;
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const suggested = typeof row.tag === 'string' && isRubricTag(row.tag) ? row.tag : undefined;
    const storedFamily = typeof row.family === 'string' ? row.family.trim().toLowerCase() : '';
    const family = (FAMILIES as readonly string[]).includes(storedFamily) ? (storedFamily as Family) : familyOfStatement(statement, suggested);
    const guessed = correctTag(statement, suggested);
    const tag = familyOfTag(guessed) === family ? guessed : tagForStoredFamily(family, statement);
    const notes = String(row.notes ?? row.applicableIf ?? '').slice(0, 600);
    const claim =
      (typeof row.claim_key === 'string' && row.claim_key) ||
      (typeof row.claim === 'string' && row.claim) ||
      claimFromNotes(notes) ||
      slug(statement);
    out.push({ tag, statement, notes, family, claimKey: claim });
  }
  return out;
}

export function factoryStatementsFromLegacy(rows: unknown) {
  return parseLegacyRubricRows(rows).map((row) => ({
    family: row.family,
    tag: row.tag as RubricTag,
    statement: row.statement,
    notes: row.notes,
    claimKey: row.claimKey,
    origin: 'factory' as const,
    lint: lintStatement({ statement: row.statement, tag: row.tag }),
    scope: 'output' as const,
    inputFileIds: [] as string[],
    outputFile: null,
  }));
}

export function latestLegacyRun<T extends { created_at?: unknown; id?: unknown; native_generation_superseded?: unknown }>(runs: T[]): T | null {
  return (
    runs
      .filter((run) => run.native_generation_superseded !== true)
      .sort((a, b) => {
        const byTime = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
        return byTime !== 0 ? byTime : String(b.id ?? '').localeCompare(String(a.id ?? ''));
      })[0] ?? null
  );
}

const STABILITY_SOURCES = new Set(['autorate_stability_1', 'autorate_stability_2', 'autorate_stability_3']);

export interface LegacyStabilityImportGroup {
  group_id: string;
  accepted_at: string | null;
  accepted_by: string | null;
  parent_group_id: string | null;
  evaluation: { scores: number[]; spread: number };
  runs: {
    ordinal: number;
    answers: Record<string, unknown>;
    evidence: Record<string, unknown>;
    grades: Record<string, unknown>;
    scorePercent: number | null;
    model: string | null;
  }[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stabilityAcceptance(questions: unknown): { groupId: string; acceptedAt: string | null; acceptedBy: string | null } | null {
  const raw = asRecord(questions)['__observability_stability_acceptance'];
  let marker: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      marker = asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  } else {
    marker = asRecord(raw);
  }
  const groupId = typeof marker.groupId === 'string' ? marker.groupId : '';
  if (!groupId) return null;
  return {
    groupId,
    acceptedAt: typeof marker.acceptedAt === 'string' ? marker.acceptedAt : null,
    acceptedBy: typeof marker.acceptedBy === 'string' ? marker.acceptedBy : null,
  };
}

function completeStabilityGroups(autorateRuns: unknown): Map<string, LegacyStabilityImportGroup> {
  const buckets = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (const raw of Array.isArray(autorateRuns) ? autorateRuns : []) {
    const pass = asRecord(raw);
    const source = typeof pass.source === 'string' ? pass.source : '';
    const groupId = typeof pass.groupId === 'string' ? pass.groupId : '';
    if (!groupId || !STABILITY_SOURCES.has(source)) continue;
    if (!buckets.has(groupId)) {
      buckets.set(groupId, []);
      order.push(groupId);
    }
    buckets.get(groupId)!.push(pass);
  }
  const out = new Map<string, LegacyStabilityImportGroup>();
  for (const groupId of order) {
    const passes = buckets.get(groupId) ?? [];
    const sources = new Set(passes.map((pass) => pass.source));
    if (STABILITY_SOURCES.size !== sources.size || ![...STABILITY_SOURCES].every((source) => sources.has(source))) continue;
    const graded = passes.every((pass) => {
      const grades = asRecord(pass.grades);
      const errors = asRecord(pass.errors);
      const seats = Object.keys(grades);
      return seats.length > 0 && seats.every((seat) => !String(errors[seat] ?? '').trim());
    });
    if (!graded) continue;
    const runs = [...passes]
      .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
      .map((pass) => ({
        ordinal: Number(pass.ordinal ?? 0) || Number(String(pass.source).slice(-1)) || 1,
        answers: asRecord(pass.answers),
        evidence: asRecord(pass.evidence),
        grades: asRecord(pass.grades),
        scorePercent: typeof pass.scorePercent === 'number' ? pass.scorePercent : null,
        model: typeof pass.model === 'string' ? pass.model : null,
      }));
    const scores = runs.map((pass) => pass.scorePercent).filter((score): score is number => typeof score === 'number');
    const parentGroupId = passes
      .map((pass) => asRecord(pass.evidenceReview).parentGroupId)
      .find((id): id is string => typeof id === 'string' && id.length > 0) ?? null;
    out.set(groupId, {
      group_id: groupId,
      accepted_at: null,
      accepted_by: null,
      parent_group_id: parentGroupId,
      evaluation: { scores, spread: scores.length ? Math.max(...scores) - Math.min(...scores) : 0 },
      runs,
    });
  }
  return out;
}

/** Official 3-pass Stability lives in rubric_answers.autorate_runs, not local_stability_*. */
export function stabilityGroupsFromAutorate(autorateRuns: unknown, questions: unknown): LegacyStabilityImportGroup[] {
  const groups = completeStabilityGroups(autorateRuns);
  if (groups.size === 0) return [];
  const marker = stabilityAcceptance(questions);
  const lastId = [...groups.keys()].at(-1);
  const currentId = (marker && groups.has(marker.groupId) ? marker.groupId : lastId) ?? '';
  const current = groups.get(currentId);
  if (!current) return [];
  if (marker && current.group_id === marker.groupId) {
    current.accepted_at = marker.acceptedAt;
    current.accepted_by = marker.acceptedBy;
  }
  const parentId = current.parent_group_id;
  const parent = parentId && parentId !== current.group_id ? groups.get(parentId) : null;
  return parent ? [current, parent] : [current];
}

export function seedsFromLegacy(run: { seeds?: unknown; rows?: unknown }): string[] {
  if (Array.isArray(run.seeds)) {
    const listed = run.seeds.filter((seed): seed is string => typeof seed === 'string' && seed.trim().length > 0);
    if (listed.length) return listed;
  }
  const seeds = new Set<string>();
  for (const row of parseLegacyRubricRows(run.rows)) {
    const seed = row.notes.match(/seed:([a-z0-9-]+)/i)?.[1];
    if (seed) seeds.add(seed);
  }
  return [...seeds];
}

export function assignmentSeat(teamRoleKey: string): 'rubric' | 'review' | null {
  const key = teamRoleKey.trim().toLowerCase();
  if (/review/.test(key)) return 'review';
  if (/rubric|creator/.test(key)) return 'rubric';
  return null;
}

export function normalizeClaim(text: string): string {
  return toAffirmativeStatement(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function asLegacyVerdict(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && 'answer' in value) return asLegacyVerdict((value as { answer: unknown }).answer);
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true' || text === 'yes' || text === 'y') return true;
  if (text === 'false' || text === 'no' || text === 'n') return false;
  return null;
}

export function mapLegacySeatIds(
  runRows: readonly { id?: unknown; statement?: unknown; question?: unknown; text?: unknown; claim?: unknown }[],
  imported: readonly { id: string; statement: string; claimKey?: string | null }[],
): Map<string, string> {
  const byText = new Map(imported.map((row) => [normalizeClaim(row.statement), row.id]));
  const byClaim = new Map(imported.flatMap((row) => (row.claimKey ? [[row.claimKey, row.id] as const] : [])));
  const out = new Map<string, string>();
  for (const row of runRows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) continue;
    const statement = typeof row.statement === 'string' && row.statement.trim()
      ? row.statement
      : typeof row.question === 'string'
        ? row.question
        : typeof row.text === 'string'
          ? row.text
          : '';
    const claim = typeof row.claim === 'string' ? row.claim : '';
    const hit = byClaim.get(id) ?? (claim ? byClaim.get(claim) : undefined) ?? byText.get(normalizeClaim(statement));
    if (hit) out.set(id, hit);
  }
  return out;
}

export function remapVerdicts(legacy: Record<string, unknown> | null | undefined, seats: Map<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!legacy) return out;
  for (const [key, raw] of Object.entries(legacy)) {
    const id = seats.get(key);
    const verdict = asLegacyVerdict(raw);
    if (id && verdict !== null) out[id] = verdict;
  }
  return out;
}

export interface LegacyStabilityHostLookup {
  internalIds: Set<string>;
  catalogToInternal: Map<string, string>;
  runIdToInternal: Map<string, string>;
}

/** Attach a leftover stability group only when it still belongs to a live task. */
export function legacyStabilityHostId(
  group: { submission_id?: unknown; rubric_run_id?: unknown },
  lookup: LegacyStabilityHostLookup,
): string | null {
  const submissionId = typeof group.submission_id === 'string' ? group.submission_id : '';
  if (submissionId && lookup.internalIds.has(submissionId)) return submissionId;
  if (submissionId && lookup.catalogToInternal.has(submissionId)) return lookup.catalogToInternal.get(submissionId) ?? null;
  const runId = typeof group.rubric_run_id === 'string' ? group.rubric_run_id : '';
  return (runId && lookup.runIdToInternal.get(runId)) || null;
}

export function remapEvidence(legacy: Record<string, unknown> | null | undefined, seats: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!legacy) return out;
  for (const [key, raw] of Object.entries(legacy)) {
    const id = seats.get(key);
    const text = raw && typeof raw === 'object' && 'evidence' in raw ? String((raw as { evidence: unknown }).evidence ?? '') : typeof raw === 'string' ? raw : '';
    if (id && text.trim()) out[id] = text.trim().slice(0, 2000);
  }
  return out;
}

export function tagForStoredFamily(family: Family, statement: string): RubricTag {
  const guessed = correctTag(statement);
  if (familyOfTag(guessed) === family) return guessed;
  if (family === 'format') return 'Format/File';
  if (family === 'visual') return 'Visual - Layout';
  return 'Content - Semantics';
}

function claimFromNotes(notes: string): string {
  return notes.match(/claim:([a-z0-9-]+)/i)?.[1] ?? '';
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'claim';
}
