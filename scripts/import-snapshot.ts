import './railway-target';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
import { readCatalogSubmission } from '@/lib/catalog/read';
import { keepCatalogId } from '@/domain/cutoverKeep';
import { installFactoryVersion } from '@/lib/services/rubric';
import { syncSubmission } from '@/lib/services/submissions';

/**
 * Writes the read-only Supabase snapshot into app.* on DATABASE_URL
 * (Neon today, Cloud SQL later). Never writes to live Supabase.
 *
 *   npm run db:import-snapshot                 dry-run
 *   npm run db:import-snapshot -- --apply      write (keep extra local rows)
 *   npm run db:import-snapshot -- --clone      write and drop rows that are not in the snapshot
 */

const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');

interface LegacySubmission {
  id: string;
  submission_id: string;
  project_id: string;
  submission: unknown;
  project: unknown;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  looked_up_by?: string | null;
}

function arg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

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

function isSupabaseHost(url: string): boolean {
  return /supabase\.(co|com)|pooler\.supabase/i.test(url);
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.pathname || '(unknown)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function roleKeysFromLegacy(): Map<string, string[]> {
  const roles = load('public.roles.json');
  const byId = new Map<string, string>();
  for (const raw of roles) {
    if (!isRecord(raw)) continue;
    const id = str(raw, 'id');
    const key = str(raw, 'key', 'name', 'slug', 'role_key', 'role');
    if (id && key) byId.set(id, key);
  }
  const grants = load('public.user_roles.json');
  const out = new Map<string, string[]>();
  for (const raw of grants) {
    if (!isRecord(raw)) continue;
    const userId = str(raw, 'user_id', 'userId');
    if (!userId) continue;
    const key = str(raw, 'role', 'role_key', 'team_role_key') || byId.get(str(raw, 'role_id')) || '';
    if (!key) continue;
    const list = out.get(userId) ?? [];
    list.push(key);
    out.set(userId, list);
  }
  return out;
}

function plannedUsers() {
  const roleKeys = roleKeysFromLegacy();
  const people = new Map<string, { email: string; displayName: string; roles: LegacyAppRole[] }>();
  for (const raw of load('public.profiles.json')) {
    if (!isRecord(raw)) continue;
    const id = str(raw, 'id');
    const email = str(raw, 'email').toLowerCase();
    if (!id || !email) continue;
    people.set(id, {
      email,
      displayName: str(raw, 'display_name', 'displayName', 'full_name', 'name'),
      roles: mapLegacyRoles(roleKeys.get(id) ?? []),
    });
  }
  const mention = (id: string | null | undefined) => {
    if (!id || people.has(id)) return;
    people.set(id, { email: `imported-${id}@gdp.invalid`, displayName: 'Imported user', roles: [] });
  };
  for (const raw of load<LegacySubmission>('public.wirestock_submissions.json')) mention(raw.looked_up_by);
  for (const raw of load('public.wirestock_submission_assignments.json')) {
    if (!isRecord(raw)) continue;
    mention(str(raw, 'assignee_id'));
    mention(str(raw, 'assigned_by'));
    const userId = str(raw, 'assignee_id');
    const seat = assignmentSeat(str(raw, 'team_role_key'));
    if (userId && seat) {
      const person = people.get(userId);
      if (person && person.roles.length === 0) person.roles = mapLegacyRoles([str(raw, 'team_role_key')]);
    }
  }
  for (const raw of load('public.wirestock_rubric_runs.json')) {
    if (isRecord(raw)) mention(str(raw, 'created_by'));
  }
  return people;
}

function plannedProjects() {
  const projects = new Map<string, { label: string; workStatusId: string; handoffStatusId: string; statusIds: string[]; project: unknown }>();
  const remember = (
    id: string,
    patch: Partial<{ label: string; workStatusId: string; handoffStatusId: string; statusIds: string[]; project: unknown }>,
    create = true,
  ) => {
    if (!id) return;
    if (!create && !projects.has(id)) return;
    const current = projects.get(id) ?? { label: '', workStatusId: '', handoffStatusId: '', statusIds: [], project: null };
    projects.set(id, {
      label: patch.label || current.label,
      workStatusId: patch.workStatusId || current.workStatusId,
      handoffStatusId: patch.handoffStatusId || current.handoffStatusId,
      statusIds: patch.statusIds?.length ? patch.statusIds : current.statusIds,
      project: patch.project ?? current.project,
    });
  };
  for (const raw of [...load('public.watched_projects.json'), ...load('public.wirestock_project_watches.json')]) {
    if (!isRecord(raw)) continue;
    remember(str(raw, 'project_id', 'projectId'), {
      label: str(raw, 'label', 'name'),
      workStatusId: str(raw, 'work_status_id', 'workStatusId'),
      handoffStatusId: str(raw, 'handoff_status_id', 'handoffStatusId'),
      statusIds: Array.isArray(raw['status_ids']) ? raw['status_ids'].filter((id): id is string => typeof id === 'string') : [],
    });
  }
  for (const raw of load('public.wirestock_project_features.json')) {
    if (!isRecord(raw)) continue;
    remember(
      str(raw, 'project_id', 'projectId'),
      {
        workStatusId: str(raw, 'work_status_id', 'workStatusId'),
        handoffStatusId: str(raw, 'handoff_status_id', 'handoffStatusId'),
      },
      false,
    );
  }
  for (const raw of load<LegacySubmission>('public.wirestock_submissions.json')) {
    const project = isRecord(raw.project) ? raw.project : null;
    remember(
      raw.project_id,
      {
        label: project && typeof project.name === 'string' ? project.name : '',
        project: raw.project ?? null,
      },
      false,
    );
  }
  return projects;
}

function latestReviewStatus(internalId: string): LegacyReviewStatus | null {
  const rows = [...load('public.wirestock_reviews_v1.json'), ...load('public.wirestock_submission_reviews.json')]
    .filter(isRecord)
    .filter((row) => str(row, 'submission_id') === internalId)
    .sort((a, b) => str(b, 'updated_at', 'decision_at', 'created_at').localeCompare(str(a, 'updated_at', 'decision_at', 'created_at')));
  const status = str(rows[0] ?? {}, 'status').toLowerCase();
  if (status === 'pending' || status === 'approved' || status === 'changes_requested') return status;
  return null;
}

function plannedTasks() {
  const states = new Map(
    load('public.wirestock_submission_states.json')
      .filter(isRecord)
      .map((row) => [str(row, 'submission_id'), str(row, 'state')]),
  );
  const handoffs = new Map(
    load('public.wirestock_submission_handoffs.json')
      .filter(isRecord)
      .map((row) => [str(row, 'submission_id'), str(row, 'status')]),
  );
  const watches = plannedProjects();
  const assignments = load('public.wirestock_submission_assignments.json').filter(isRecord);
  const runs = load('public.wirestock_rubric_runs.json').filter(isRecord);
  const runsByInternal = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) {
    const id = str(run, 'submission_id');
    const list = runsByInternal.get(id) ?? [];
    list.push(run);
    runsByInternal.set(id, list);
  }
  return load<LegacySubmission>('public.wirestock_submissions.json').map((row) => {
    const read = readCatalogSubmission(row.submission, row.project);
    const latest = latestLegacyRun(runsByInternal.get(row.id) ?? []);
    const statements = factoryStatementsFromLegacy(latest?.['rows']);
    const seats = { rubric: null as string | null, review: null as string | null };
    let assigned = false;
    for (const raw of assignments.filter((a) => str(a, 'submission_id') === row.id)) {
      const seat = assignmentSeat(str(raw, 'team_role_key'));
      const who = str(raw, 'assignee_id');
      if (seat) assigned = true;
      if (seat && who) seats[seat] = who;
    }
    const watch = watches.get(row.project_id);
    const project = isRecord(row.project) ? row.project : {};
    const workflow = isRecord(project['workflow']) ? project['workflow'] : {};
    const pipeline = inferLegacyPipeline({
      catalogStatusId: read?.statusId ?? null,
      catalogStatusName: read?.statusName ?? null,
      workStatusId: watch?.workStatusId ?? null,
      handoffStatusId: watch?.handoffStatusId ?? null,
      listStatusIds: watch?.statusIds ?? [],
      catalogStatuses: workflow['statuses'],
      catalogTransitions: workflow['transitions'],
      gdpState: states.get(row.id) ?? null,
      reviewStatus: latestReviewStatus(row.id),
      handoffStatus: handoffs.get(row.id) ?? null,
      hasAssignee: Boolean(seats.rubric),
      assigned,
    });
    return {
      internalId: row.id,
      catalogId: row.submission_id,
      projectId: row.project_id,
      statusId: read?.statusId ?? null,
      title: read?.title || '',
      stage: pipeline.stage,
      reviewStatus: pipeline.reviewStatus,
      handoffStatus: pipeline.handoffStatus,
      seats,
      statements: statements.length,
      seeds: latest ? seedsFromLegacy(latest) : [],
      factory: statements,
      source: { submission: row.submission, project: row.project },
      fingerprint: sourceFingerprint(row.submission),
      landedAt: row.first_seen_at ?? row.last_seen_at ?? new Date().toISOString(),
      lastSeenAt: row.last_seen_at ?? row.first_seen_at ?? new Date().toISOString(),
      lookedUpBy: row.looked_up_by ?? null,
    };
  });
}

async function main() {
  const clone = arg('--clone');
  const apply = arg('--apply') || clone;
  const replace = arg('--replace') || clone;
  const syncCatalog = arg('--sync-catalog');
  const limit = clone ? undefined : Number(argValue('--limit') ?? 0) || undefined;
  const target = process.env['DATABASE_URL']?.trim() ?? '';
  if (!target) {
    console.error('DATABASE_URL is not set. Point it at Cloud SQL (or a scratch Neon) — never at live Supabase.');
    process.exit(2);
  }
  if (isSupabaseHost(target) || target === process.env['SUPABASE_READ_DATABASE_URL']?.trim()) {
    console.error('Refusing: DATABASE_URL is a Supabase host. This importer never writes to live Supabase.');
    process.exit(2);
  }
  if (!existsSync(path.join(SNAP, 'index.json'))) {
    console.error(`No snapshot at ${SNAP}. Run npm run db:snapshot-supabase first.`);
    process.exit(2);
  }

  const users = plannedUsers();
  const projects = plannedProjects();
  const allTasks = plannedTasks();
  const keepOnly = !arg('--all');
  const tasks = (keepOnly ? allTasks.filter((task) => keepCatalogId(task.catalogId)) : allTasks).slice(0, limit);
  const withRubric = tasks.filter((t) => t.statements > 0).length;
  const withSeat = tasks.filter((t) => t.seats.rubric || t.seats.review).length;
  const roleCounts = { admin: 0, pm: 0, rubric_creator: 0, reviewer: 0 };
  for (const person of users.values()) for (const role of person.roles) roleCounts[role] += 1;

  console.log(`Target: ${hostOf(target)} (${clone ? 'CLONE' : apply ? 'APPLY' : 'dry-run'})`);
  console.log(`Users: ${users.size}  roles ${JSON.stringify(roleCounts)}`);
  console.log(`Watched projects: ${projects.size}`);
  console.log(`Tasks: ${tasks.length}${keepOnly ? ` keep-set (of ${allTasks.length})` : ''}  with current rubric ${withRubric}  with a seat ${withSeat}`);
  console.log('Skipped on purpose: golden ratings, calibrations, stability, human AI eval (hash/file bound).');

  if (!apply) {
    console.log('Re-run with --apply to write, or --clone to replace Neon with the snapshot and drop leftover fixture rows.');
    process.exit(0);
  }

  const database = db();
  let usersWritten = 0;
  for (const [id, person] of users) {
    const byEmail = (await database.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, person.email)).limit(1))[0];
    if (byEmail && byEmail.id !== id) {
      console.warn(`Skip profile ${id} (${person.email}): email already belongs to ${byEmail.id}`);
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
    usersWritten += 1;
  }

  let projectsWritten = 0;
  for (const [projectId, project] of projects) {
    await database
      .insert(watchedProjects)
      .values({
        projectId,
        label: project.label,
        workStatusId: project.workStatusId,
        handoffStatusId: project.handoffStatusId,
        statusIds: project.statusIds,
        project: project.project,
        projectFetchedAt: project.project ? new Date().toISOString() : null,
      })
      .onConflictDoUpdate({
        target: watchedProjects.projectId,
        set: {
          label: project.label,
          workStatusId: project.workStatusId,
          handoffStatusId: project.handoffStatusId,
          statusIds: project.statusIds,
          project: project.project,
          projectFetchedAt: project.project ? new Date().toISOString() : null,
        },
      });
    projectsWritten += 1;
  }

  const knownProfile = async (id: string | null) => {
    if (!id) return null;
    return (await database.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).limit(1))[0]?.id ?? null;
  };

  let tasksWritten = 0;
  let rubricsWritten = 0;
  let skippedExisting = 0;
  for (const task of tasks) {
    if (!task.catalogId) continue;
    const existing = (await database.select().from(submissions).where(eq(submissions.catalogSubmissionId, task.catalogId)).limit(1))[0];
    if (existing && !replace) {
      skippedExisting += 1;
      continue;
    }
    const rubricAssigneeId = await knownProfile(task.seats.rubric);
    const reviewerId = await knownProfile(task.seats.review);
    let row = existing;
    if (!row) {
      const [created] = await database
        .insert(submissions)
        .values({
          catalogSubmissionId: task.catalogId,
          projectId: task.projectId,
          statusId: task.statusId,
          title: task.title,
          source: task.source as Record<string, unknown>,
          sourceFingerprint: task.fingerprint,
          landedAt: task.landedAt,
          lastSeenAt: task.lastSeenAt,
          stage: task.stage as Stage,
          reviewStatus: task.reviewStatus as ReviewStatus | null,
          handoffStatus: task.handoffStatus as HandoffStatus | null,
          pushedAt: task.stage === 'done' ? task.lastSeenAt : null,
          rubricAssigneeId,
          reviewerId,
          lastClaimedAt: rubricAssigneeId || reviewerId ? task.lastSeenAt : null,
        })
        .returning();
      row = created!;
    } else {
      const [updated] = await database
        .update(submissions)
        .set({
          projectId: task.projectId,
          statusId: task.statusId,
          title: task.title,
          source: task.source as Record<string, unknown>,
          sourceFingerprint: task.fingerprint,
          lastSeenAt: task.lastSeenAt,
          stage: task.stage as Stage,
          reviewStatus: task.reviewStatus as ReviewStatus | null,
          handoffStatus: task.handoffStatus as HandoffStatus | null,
          pushedAt: task.stage === 'done' ? task.lastSeenAt : null,
          rubricAssigneeId,
          reviewerId,
        })
        .where(eq(submissions.id, row.id))
        .returning();
      row = updated!;
    }
    if (syncCatalog) {
      try {
        row = await syncSubmission(task.catalogId, task.lookedUpBy);
      } catch (error) {
        console.warn(`Catalog refresh failed for ${task.catalogId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (task.factory.length) {
      const installed = await installFactoryVersion(database, row.id, null, {
        seeds: task.seeds,
        statements: task.factory,
        generation: { provenance: 'legacy-snapshot', catalogId: task.catalogId, statements: task.factory.length },
      });
      rubricsWritten += 1;
      if (task.stage === 'review' || task.reviewStatus) {
        await database.update(submissions).set({ reviewRubricId: installed.id }).where(eq(submissions.id, row.id));
      }
    }
    tasksWritten += 1;
  }

  let removedTasks = 0;
  let removedProjects = 0;
  if (clone) {
    const keepTasks = new Set(allTasks.map((task) => task.catalogId));
    const extras = await database.select({ id: submissions.id, catalogSubmissionId: submissions.catalogSubmissionId }).from(submissions);
    for (const extra of extras) {
      if (keepTasks.has(extra.catalogSubmissionId)) continue;
      await database.delete(submissions).where(eq(submissions.id, extra.id));
      removedTasks += 1;
    }
    const keepProjects = new Set(projects.keys());
    const extraProjects = await database.select({ projectId: watchedProjects.projectId }).from(watchedProjects);
    for (const extra of extraProjects) {
      if (keepProjects.has(extra.projectId)) continue;
      await database.delete(watchedProjects).where(eq(watchedProjects.projectId, extra.projectId));
      removedProjects += 1;
    }
  }

  console.log(`Wrote users=${usersWritten} projects=${projectsWritten} tasks=${tasksWritten} rubrics=${rubricsWritten} skippedExisting=${skippedExisting}${clone ? ` removedExtras tasks=${removedTasks} projects=${removedProjects}` : ''}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
