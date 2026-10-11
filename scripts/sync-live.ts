import './env';
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, submissions, userRoles, watchedProjects, type HandoffStatus, type ReviewStatus, type Role, type Stage } from '@/db/schema';
import { sourceFingerprint } from '@/domain/fingerprint';
import {
  assignmentSeat,
  factoryStatementsFromLegacy,
  inferLegacyPipeline,
  latestLegacyRun,
  mapLegacyRoles,
  seedsFromLegacy,
  type LegacyAppRole,
  type LegacyReviewStatus,
} from '@/domain/legacyImport';
import { workStateOf } from '@/domain/workState';
import { readCatalogSubmission } from '@/lib/catalog/read';
import { installFactoryVersion } from '@/lib/services/rubric';

/**
 * Full read of live Supabase (+ Catalog refresh) into DATABASE_URL.
 * Never writes to live.
 *
 *   npm run db:sync-live
 *   npm run db:sync-live -- --apply
 *   npm run db:sync-live -- --apply --new-only --board-only --no-catalog
 *
 * --new-only    insert catalog ids we do not have; never overwrite Railway rows
 * --board-only  new rows only if they are on a watched work/handoff status
 *               (tasks already on Railway are always refreshed)
 */

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

function isSupabaseHost(url: string): boolean {
  return /supabase\.(co|com)|pooler\.supabase/i.test(url);
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const index = i;
        i += 1;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

async function catalogJson(path: string): Promise<unknown | null> {
  const token = process.env['WIRESTOCK_API_TOKEN']?.trim();
  if (!token) return null;
  const base = (process.env['WIRESTOCK_API_BASE_URL'] ?? 'https://api.wirestock.io/data-program/core').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function statusOf(rawSubmission: unknown, rawProject: unknown): { statusId: string | null; statusName: string | null; title: string } {
  const read = readCatalogSubmission(rawSubmission, rawProject);
  return { statusId: read?.statusId ?? null, statusName: read?.statusName ?? null, title: read?.title ?? '' };
}

function latestStamp(...values: Array<string | null | undefined>): string | null {
  const times = values.map((value) => (value ? Date.parse(value) : NaN)).filter((n) => Number.isFinite(n));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function mergeLiveStatus(preferred: unknown, live: unknown): unknown {
  if (!isRecord(preferred) || !isRecord(live)) return preferred;
  const liveWorkflow = isRecord(live['workflowState']) ? live['workflowState'] : null;
  const liveStatus = liveWorkflow ? str(liveWorkflow, 'statusId') : '';
  if (!liveStatus) return preferred;
  const current = isRecord(preferred['workflowState']) ? preferred['workflowState'] : {};
  return { ...preferred, workflowState: { ...current, statusId: liveStatus } };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const skipCatalog = process.argv.includes('--no-catalog');
  const newOnly = process.argv.includes('--new-only');
  const boardOnly = process.argv.includes('--board-only');
  const target = process.env['DATABASE_URL']?.trim() ?? '';
  if (!target) throw new Error('DATABASE_URL is not set.');
  if (isSupabaseHost(target)) throw new Error('Refusing: DATABASE_URL is a Supabase host.');

  const url = (process.env['SUPABASE_READ_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'])?.trim();
  const key = (process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'])?.trim();
  if (!url || !key) throw new Error('Live read credentials are missing.');
  const live = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const [subs, watches, assigns, reviews, reviewsV1, states, handoffs, runs, people, roles, grants] = await Promise.all([
    live.from('wirestock_submissions').select('*'),
    live.from('watched_projects').select('*'),
    live.from('wirestock_submission_assignments').select('*'),
    live.from('wirestock_submission_reviews').select('*'),
    live.from('wirestock_reviews_v1').select('*'),
    live.from('wirestock_submission_states').select('*'),
    live.from('wirestock_submission_handoffs').select('*'),
    live.from('wirestock_rubric_runs').select('id,submission_id,rows,seeds,created_at'),
    live.from('profiles').select('*'),
    live.from('roles').select('*'),
    live.from('user_roles').select('*'),
  ]);
  for (const result of [subs, watches, assigns, reviews, reviewsV1, states, handoffs, runs, people]) {
    if (result.error) throw new Error(result.error.message);
  }

  const watchBy = new Map((watches.data ?? []).filter(isRecord).map((row) => [str(row, 'project_id'), row]));
  const stateBy = new Map((states.data ?? []).filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'state')]));
  const handoffBy = new Map((handoffs.data ?? []).filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'status')]));
  const reviewRows = [...(reviews.data ?? []), ...(reviewsV1.data ?? [])].filter(isRecord);
  const reviewOf = (internalId: string): LegacyReviewStatus | null => {
    const row = reviewRows
      .filter((r) => str(r, 'submission_id') === internalId)
      .sort((a, b) => str(b, 'updated_at', 'decision_at', 'created_at').localeCompare(str(a, 'updated_at', 'decision_at', 'created_at')))[0];
    const status = str(row ?? {}, 'status').toLowerCase();
    if (status === 'pending' || status === 'approved' || status === 'changes_requested') return status;
    return null;
  };
  const runsBy = new Map<string, Record<string, unknown>[]>();
  for (const run of (runs.data ?? []).filter(isRecord)) {
    const id = str(run, 'submission_id');
    const list = runsBy.get(id) ?? [];
    list.push(run);
    runsBy.set(id, list);
  }
  const seatsOf = (internalId: string) => {
    const seats = { rubric: null as string | null, review: null as string | null };
    for (const raw of (assigns.data ?? []).filter(isRecord).filter((row) => str(row, 'submission_id') === internalId)) {
      const seat = assignmentSeat(str(raw, 'team_role_key'));
      const who = str(raw, 'assignee_id');
      if (seat && who) seats[seat] = who;
    }
    return seats;
  };

  const roleById = new Map<string, string>();
  for (const raw of (roles.data ?? []).filter(isRecord)) {
    const id = str(raw, 'id');
    const name = str(raw, 'key', 'name', 'slug', 'role_key', 'role');
    if (id && name) roleById.set(id, name);
  }
  const roleKeys = new Map<string, string[]>();
  for (const raw of (grants.error ? [] : grants.data ?? []).filter(isRecord)) {
    const userId = str(raw, 'user_id', 'userId');
    if (!userId) continue;
    const key = str(raw, 'role', 'role_key', 'team_role_key') || roleById.get(str(raw, 'role_id')) || '';
    if (!key) continue;
    const list = roleKeys.get(userId) ?? [];
    list.push(key);
    roleKeys.set(userId, list);
  }
  const plannedPeople = new Map<string, { email: string; displayName: string; roles: LegacyAppRole[] }>();
  for (const raw of (people.data ?? []).filter(isRecord)) {
    const id = str(raw, 'id');
    const email = str(raw, 'email').toLowerCase();
    if (!id || !email) continue;
    plannedPeople.set(id, {
      email,
      displayName: str(raw, 'display_name', 'displayName', 'full_name', 'name'),
      roles: mapLegacyRoles(roleKeys.get(id) ?? []),
    });
  }
  for (const raw of (assigns.data ?? []).filter(isRecord)) {
    const userId = str(raw, 'assignee_id');
    if (!userId || plannedPeople.has(userId)) continue;
    plannedPeople.set(userId, { email: `imported-${userId}@gdp.invalid`, displayName: 'Imported user', roles: mapLegacyRoles([str(raw, 'team_role_key')]) });
  }

  const projectIds = [...new Set((subs.data ?? []).filter(isRecord).map((row) => str(row, 'project_id')).filter(Boolean))];
  console.log(`Live: ${(subs.data ?? []).length} submissions, ${watchBy.size} watches, ${plannedPeople.size} people.`);
  const projectCache = new Map<string, unknown>();
  if (!skipCatalog) {
    console.log('Refreshing Catalog payloads…');
    for (const projectId of projectIds) {
      const fetched = await catalogJson(`/projects/${encodeURIComponent(projectId)}`);
      if (fetched) projectCache.set(projectId, fetched);
    }
    console.log(`Catalog projects ${projectCache.size} / ${projectIds.length}`);
  }

  const refreshed = await pool((subs.data ?? []).filter(isRecord), skipCatalog ? 1 : 4, async (row) => {
    const catalogId = str(row, 'submission_id');
    const fetched = !skipCatalog && catalogId ? await catalogJson(`/project-submissions/${encodeURIComponent(catalogId)}`) : null;
    const liveSubmission = row['submission'];
    const liveProject = row['project'];
    const projectId = str(row, 'project_id') || (isRecord(fetched) ? str(fetched, 'projectId') : '');
    const project = projectCache.get(projectId) ?? liveProject;
    const submission = mergeLiveStatus(isRecord(fetched) ? fetched : liveSubmission, liveSubmission);
    return { row, catalogId, submission, project, liveSubmission, liveProject, catalogOk: isRecord(fetched) };
  });
  const catalogHits = refreshed.filter((r) => r.catalogOk).length;
  if (!skipCatalog) console.log(`Catalog refreshed ${catalogHits} / ${refreshed.length}`);

  const database = db();
  const counts: Record<string, number> = {};
  const boardCounts: Record<string, number> = {};
  let written = 0;
  let incoming = 0;
  let rubrics = 0;
  let titled = 0;
  let peopleWritten = 0;

  if (apply && !newOnly) {
    for (const [id, person] of plannedPeople) {
      const byEmail = (await database.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, person.email)).limit(1))[0];
      if (byEmail && byEmail.id !== id) {
        console.warn(`Skip profile ${id}: email already belongs to another id`);
        continue;
      }
      await database
        .insert(profiles)
        .values({ id, email: person.email, displayName: person.displayName || null })
        .onConflictDoUpdate({ target: profiles.id, set: { email: person.email, displayName: person.displayName || null, isActive: true } });
      await database.delete(userRoles).where(eq(userRoles.userId, id));
      if (person.roles.length) {
        await database.insert(userRoles).values(person.roles.map((role) => ({ userId: id, role: role as Role })));
      }
      peopleWritten += 1;
    }
  }

  const knownUsers = new Set((await database.select({ id: profiles.id }).from(profiles)).map((row) => row.id));
  for (const id of plannedPeople.keys()) knownUsers.add(id);
  const known = (id: string | null) => (id && knownUsers.has(id) ? id : null);
  const existing = await database.select().from(submissions);
  const byCatalog = new Map(existing.map((row) => [row.catalogSubmissionId, row]));

  if (apply) {
    if (!newOnly) {
      const liveProjectIds = [...watchBy.keys()];
      const existingWatches = await database.select({ projectId: watchedProjects.projectId }).from(watchedProjects);
      for (const row of existingWatches) {
        if (!liveProjectIds.includes(row.projectId)) {
          await database.delete(watchedProjects).where(eq(watchedProjects.projectId, row.projectId));
        }
      }
    }
    for (const watch of watchBy.values()) {
      const projectId = str(watch, 'project_id');
      if (!projectId) continue;
      const project = projectCache.get(projectId) ?? watch['project'] ?? null;
      await database
        .insert(watchedProjects)
        .values({
          projectId,
          label: str(watch, 'label'),
          workStatusId: str(watch, 'work_status_id'),
          handoffStatusId: str(watch, 'handoff_status_id'),
          statusIds: Array.isArray(watch['status_ids']) ? (watch['status_ids'] as string[]) : [],
          project,
          projectFetchedAt: project ? new Date().toISOString() : null,
        })
        .onConflictDoUpdate({
          target: watchedProjects.projectId,
          set: {
            label: str(watch, 'label'),
            workStatusId: str(watch, 'work_status_id'),
            handoffStatusId: str(watch, 'handoff_status_id'),
            statusIds: Array.isArray(watch['status_ids']) ? (watch['status_ids'] as string[]) : [],
            project,
            projectFetchedAt: project ? new Date().toISOString() : null,
          },
        });
    }
  }

  for (const item of refreshed) {
    if (!item.catalogId) continue;
    const liveStatus = statusOf(item.liveSubmission, item.liveProject);
    const catalogStatus = readCatalogSubmission(item.submission, item.project);
    const watch = watchBy.get(str(item.row, 'project_id'));
    const pipeline = inferLegacyPipeline({
      catalogStatusId: liveStatus.statusId,
      catalogStatusName: liveStatus.statusName,
      workStatusId: watch ? str(watch, 'work_status_id') : null,
      handoffStatusId: watch ? str(watch, 'handoff_status_id') : null,
      listStatusIds: watch && Array.isArray(watch['status_ids']) ? (watch['status_ids'] as string[]) : [],
      gdpState: stateBy.get(str(item.row, 'id')) ?? null,
      reviewStatus: reviewOf(str(item.row, 'id')),
      handoffStatus: handoffBy.get(str(item.row, 'id')) ?? null,
      hasAssignee: Boolean(seatsOf(str(item.row, 'id')).rubric),
    });
    const seats = seatsOf(str(item.row, 'id'));
    const title = catalogStatus?.title || liveStatus.title;
    if (title) titled += 1;
    const label = workStateOf({
      stage: pipeline.stage as Stage,
      rubricAssigneeId: seats.rubric,
      reviewStatus: pipeline.reviewStatus,
      handoffStatus: pipeline.handoffStatus,
    });
    counts[label] = (counts[label] ?? 0) + 1;
    const onBoard = Boolean(
      watch &&
        liveStatus.statusId &&
        (liveStatus.statusId === str(watch, 'work_status_id') ||
          liveStatus.statusId === str(watch, 'handoff_status_id') ||
          (Array.isArray(watch['status_ids']) && (watch['status_ids'] as string[]).includes(liveStatus.statusId))),
    );
    if (onBoard) boardCounts[label] = (boardCounts[label] ?? 0) + 1;

    const have = byCatalog.get(item.catalogId);
    if (newOnly && have) continue;
    if (!have && boardOnly && !onBoard) continue;
    incoming += 1;
    if (!apply) continue;

    for (const userId of [seats.rubric, seats.review]) {
      if (!userId || knownUsers.has(userId)) continue;
      const person = plannedPeople.get(userId);
      if (!person) continue;
      await database.insert(profiles).values({ id: userId, email: person.email, displayName: person.displayName || null }).onConflictDoNothing();
      if (person.roles.length) {
        await database.insert(userRoles).values(person.roles.map((role) => ({ userId, role: role as Role }))).onConflictDoNothing();
      }
      knownUsers.add(userId);
      peopleWritten += 1;
    }

    const source = { submission: item.submission, project: item.project } as Record<string, unknown>;
    const values = {
      catalogSubmissionId: item.catalogId,
      projectId: str(item.row, 'project_id') || catalogStatus?.projectId || '',
      statusId: liveStatus.statusId,
      title,
      source,
      sourceFingerprint: sourceFingerprint(item.submission),
      lastSeenAt: latestStamp(str(item.row, 'last_seen_at'), str(item.row, 'edited_at'), have?.lastSeenAt) || new Date().toISOString(),
      stage: pipeline.stage as Stage,
      reviewStatus: pipeline.reviewStatus as ReviewStatus | null,
      handoffStatus: pipeline.handoffStatus as HandoffStatus | null,
      rubricAssigneeId: known(seats.rubric),
      reviewerId: known(seats.review),
    };
    const claimedAt = values.rubricAssigneeId || values.reviewerId ? values.lastSeenAt : null;
    const row = have
      ? (
          await database
            .update(submissions)
            .set({
              ...values,
              lastClaimedAt: claimedAt ?? have.lastClaimedAt,
              rubricClaimedAt: values.rubricAssigneeId
                ? values.rubricAssigneeId === have.rubricAssigneeId
                  ? (have.rubricClaimedAt ?? values.lastSeenAt)
                  : values.lastSeenAt
                : null,
              reviewClaimedAt: values.reviewerId
                ? values.reviewerId === have.reviewerId
                  ? (have.reviewClaimedAt ?? values.lastSeenAt)
                  : values.lastSeenAt
                : null,
              updatedAt: values.lastSeenAt,
            })
            .where(eq(submissions.id, have.id))
            .returning()
        )[0]
      : (
          await database
            .insert(submissions)
            .values({
              ...values,
              landedAt: str(item.row, 'first_seen_at') || values.lastSeenAt,
              lastClaimedAt: claimedAt,
              rubricClaimedAt: values.rubricAssigneeId ? values.lastSeenAt : null,
              reviewClaimedAt: values.reviewerId ? values.lastSeenAt : null,
            })
            .returning()
        )[0];
    if (!row) continue;
    byCatalog.set(item.catalogId, row);
    written += 1;

    const latest = latestLegacyRun(runsBy.get(str(item.row, 'id')) ?? []);
    const factory = factoryStatementsFromLegacy(latest?.['rows']);
    if (factory.length && (await needsRubric(row.id))) {
      await installFactoryVersion(database, row.id, null, {
        seeds: latest ? seedsFromLegacy(latest) : [],
        statements: factory,
        generation: { provenance: 'live-sync', catalogId: item.catalogId },
      });
      rubrics += 1;
    }
  }

  console.log(`${apply ? 'Wrote' : 'Would sync'} tasks=${apply ? written : incoming} people=${apply ? peopleWritten : plannedPeople.size} titled=${titled} newRubrics=${rubrics}${newOnly || boardOnly ? ` (new-only=${newOnly} board-only=${boardOnly})` : ''}`);
  console.log('All', counts);
  console.log('Board (watched ∩ list)', boardCounts);
  if (!apply) console.log('Re-run with --apply to write.');
  process.exit(0);
}

async function needsRubric(submissionId: string): Promise<boolean> {
  const { currentRubric } = await import('@/lib/services/rubric');
  return !(await currentRubric(db(), submissionId));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
