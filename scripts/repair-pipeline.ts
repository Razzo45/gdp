import './env';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissions, watchedProjects, type HandoffStatus, type ReviewStatus, type Stage } from '@/db/schema';
import { inferLegacyPipeline, type LegacyReviewStatus } from '@/domain/legacyImport';
import { workStateOf } from '@/domain/workState';
import { readCatalogSubmission } from '@/lib/catalog/read';

/** Re-tags Neon stages from the live GDP classifier. Never writes Catalog payloads. */
const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

function load<T = Record<string, unknown>>(name: string): T[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function latestReview(internalId: string): LegacyReviewStatus | null {
  const rows = [...load('public.wirestock_reviews_v1.json'), ...load('public.wirestock_submission_reviews.json')]
    .filter(isRecord)
    .filter((row) => str(row, 'submission_id') === internalId)
    .sort((a, b) => str(b, 'updated_at', 'decision_at', 'created_at').localeCompare(str(a, 'updated_at', 'decision_at', 'created_at')));
  const status = str(rows[0] ?? {}, 'status').toLowerCase();
  if (status === 'pending' || status === 'approved' || status === 'changes_requested') return status;
  return null;
}

function assignedOf(internalId: string): boolean {
  return load('public.wirestock_submission_assignments.json')
    .filter(isRecord)
    .some((row) => str(row, 'submission_id') === internalId && (str(row, 'assignee_id') || str(row, 'team_role_key')));
}

function workflowOf(raw: unknown): { statuses: unknown; transitions: unknown } {
  const project = isRecord(raw) ? raw : {};
  const workflow = isRecord(project['workflow']) ? project['workflow'] : {};
  return { statuses: workflow['statuses'] ?? [], transitions: workflow['transitions'] ?? [] };
}

async function observeStatus(catalogId: string): Promise<{ statusId: string | null; unavailable: boolean; project: unknown | null }> {
  const base = (process.env['WIRESTOCK_API_BASE_URL'] ?? '').replace(/\/+$/, '');
  const token = process.env['WIRESTOCK_API_TOKEN']?.trim();
  if (!base || !token) return { statusId: null, unavailable: true, project: null };
  try {
    const response = await fetch(`${base}/project-submissions/${encodeURIComponent(catalogId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return { statusId: null, unavailable: true, project: null };
    if (!response.ok) return { statusId: null, unavailable: false, project: null };
    const raw: unknown = await response.json().catch(() => null);
    const body = isRecord(raw) ? raw : {};
    const state = isRecord(body['workflowState']) ? body['workflowState'] : {};
    const statusId = typeof state['statusId'] === 'string' ? state['statusId'] : null;
    return { statusId, unavailable: false, project: null };
  } catch {
    return { statusId: null, unavailable: false, project: null };
  }
}

async function observeProject(projectId: string): Promise<unknown | null> {
  const base = (process.env['WIRESTOCK_API_BASE_URL'] ?? '').replace(/\/+$/, '');
  const token = process.env['WIRESTOCK_API_TOKEN']?.trim();
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}/projects/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const index = i++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const observe = !process.argv.includes('--no-observe');
  const legacy = load('public.wirestock_submissions.json').filter(isRecord);
  const internalOf = new Map(legacy.map((row) => [str(row, 'submission_id'), str(row, 'id')]));
  const states = new Map(load('public.wirestock_submission_states.json').filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'state')]));
  const handoffs = new Map(load('public.wirestock_submission_handoffs.json').filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'status')]));
  const listByProject = new Map(
    load('public.watched_projects.json')
      .filter(isRecord)
      .map((row) => [str(row, 'project_id'), Array.isArray(row['status_ids']) ? (row['status_ids'] as string[]) : []]),
  );

  const database = db();
  const watches = new Map((await database.select().from(watchedProjects)).map((row) => [row.projectId, row]));
  const rows = await database.select().from(submissions);

  const liveWorkflow = new Map<string, { statuses: unknown; transitions: unknown }>();
  if (observe) {
    for (const projectId of [...new Set(rows.map((row) => row.projectId))]) {
      const fresh = await observeProject(projectId);
      if (fresh) liveWorkflow.set(projectId, workflowOf(fresh));
    }
  }

  const observations = new Map<string, Awaited<ReturnType<typeof observeStatus>>>();
  if (observe) {
    console.log(`Observing Catalog status for ${rows.length} tasks (read-only, not written back).`);
    const seen = await pool(rows, 6, async (row) => ({ id: row.catalogSubmissionId, seen: await observeStatus(row.catalogSubmissionId) }));
    for (const item of seen) observations.set(item.id, item.seen);
  }

  const counts: Record<string, number> = {};
  let changed = 0;
  let observed = 0;
  let unavailable = 0;
  for (const row of rows) {
    const internal = internalOf.get(row.catalogSubmissionId);
    const read = readCatalogSubmission((row.source as { submission?: unknown }).submission, (row.source as { project?: unknown }).project);
    const watch = watches.get(row.projectId);
    const saved = workflowOf((row.source as { project?: unknown }).project);
    const live = liveWorkflow.get(row.projectId) ?? saved;
    const sight = observations.get(row.catalogSubmissionId);
    if (sight?.statusId) observed += 1;
    if (sight?.unavailable) unavailable += 1;
    const pipeline = inferLegacyPipeline({
      catalogStatusId: read?.statusId ?? row.statusId,
      catalogStatusName: read?.statusName ?? null,
      observedStatusId: sight?.unavailable ? null : (sight?.statusId ?? null),
      workStatusId: watch?.workStatusId ?? null,
      handoffStatusId: watch?.handoffStatusId ?? null,
      listStatusIds: listByProject.get(row.projectId) ?? [],
      catalogStatuses: live.statuses,
      catalogTransitions: live.transitions,
      gdpState: internal ? states.get(internal) ?? null : null,
      reviewStatus: internal ? latestReview(internal) : null,
      handoffStatus: internal ? handoffs.get(internal) ?? null : null,
      assigned: internal ? assignedOf(internal) : Boolean(row.rubricAssigneeId),
      sourceUnavailable: sight?.unavailable === true,
    });
    const next = {
      stage: pipeline.stage as Stage,
      reviewStatus: pipeline.reviewStatus as ReviewStatus | null,
      handoffStatus: pipeline.handoffStatus as HandoffStatus | null,
    };
    const label = workStateOf({ ...row, ...next });
    counts[label] = (counts[label] ?? 0) + 1;
    if (row.stage === next.stage && row.reviewStatus === next.reviewStatus && row.handoffStatus === next.handoffStatus) continue;
    changed += 1;
    if (apply) {
      await database.update(submissions).set({ stage: next.stage, reviewStatus: next.reviewStatus, handoffStatus: next.handoffStatus }).where(eq(submissions.id, row.id));
    }
  }

  console.log(`${apply ? 'Wrote' : 'Would update'} ${changed} / ${rows.length} tasks`);
  if (observe) console.log(`Catalog observations: ${observed} current, ${unavailable} unavailable, ${rows.length - observed - unavailable} fell back to saved status`);
  console.log('Board', counts);
  if (!apply) console.log('Re-run with --apply to write. --no-observe uses saved Catalog status only.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
