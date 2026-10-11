import './env';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { profiles, submissions as submissionsTable, userRoles, watchedProjects, type Role } from '@/db/schema';
import { env } from '@/lib/env';
import { assignSeat, syncSubmission } from '@/lib/services/submissions';
import { HANDOFF_STATUS, project, submissions as fixtures, WORK_STATUS } from './mock/fixtures';

/**
 * `npm run db:seed` — development data for AUTH_MODE=local.
 *
 *   1. users for every role (shared password AUTH_LOCAL_PASSWORD)
 *   2. the fixture project as a watched project with work/handoff statuses
 *   3. imports the fixture submissions from the mock Catalog (must be running:
 *      `npm run mock:catalog`), assigning the first two to the two creators
 *   4. writes the "AI output" files to fixtures/ai-outputs/ for upload via the UI
 *
 * Re-runnable: everything upserts.
 */

const USERS: { email: string; name: string; roles: Role[] }[] = [
  { email: 'admin@gdp.local', name: 'Admin', roles: ['admin'] },
  { email: 'pm@gdp.local', name: 'Priya (PM)', roles: ['pm'] },
  { email: 'ana@gdp.local', name: 'Ana (creator)', roles: ['rubric_creator'] },
  { email: 'ben@gdp.local', name: 'Ben (creator)', roles: ['rubric_creator'] },
  { email: 'rita@gdp.local', name: 'Rita (reviewer)', roles: ['reviewer'] },
  { email: 'sam@gdp.local', name: 'Sam (creator + reviewer)', roles: ['rubric_creator', 'reviewer'] },
];

async function main() {
  const configuration = env();
  if (configuration.AUTH_MODE !== 'local') {
    console.error('db:seed is for AUTH_MODE=local. In Supabase mode, invite users from Settings → Users instead.');
    process.exit(2);
  }
  const database = db();

  // 1. users
  const ids = new Map<string, string>();
  for (const u of USERS) {
    const existing = (await database.select().from(profiles).where(eq(profiles.email, u.email)).limit(1))[0];
    const id = existing?.id ?? crypto.randomUUID();
    await database.insert(profiles).values({ id, email: u.email, displayName: u.name }).onConflictDoUpdate({ target: profiles.id, set: { displayName: u.name, isActive: true } });
    await database.delete(userRoles).where(eq(userRoles.userId, id));
    await database.insert(userRoles).values(u.roles.map((role) => ({ userId: id, role })));
    ids.set(u.email, id);
  }
  console.log(`Users: ${USERS.map((u) => `${u.email} [${u.roles.join('+')}]`).join(', ')}`);
  console.log(`Password for all: ${configuration.AUTH_LOCAL_PASSWORD ?? 'gdp-dev'}`);

  // 2. watched project
  await database
    .insert(watchedProjects)
    .values({ projectId: project.projectId, label: project.name, workStatusId: WORK_STATUS, handoffStatusId: HANDOFF_STATUS, project, projectFetchedAt: new Date().toISOString(), addedBy: ids.get('admin@gdp.local') })
    .onConflictDoUpdate({ target: watchedProjects.projectId, set: { label: project.name, workStatusId: WORK_STATUS, handoffStatusId: HANDOFF_STATUS, project, projectFetchedAt: new Date().toISOString() } });
  console.log(`Watched project: ${project.projectId} (work ${WORK_STATUS} → handoff ${HANDOFF_STATUS})`);

  // 3. submissions via the mock Catalog
  const pm = { id: ids.get('pm@gdp.local')!, email: 'pm@gdp.local', displayName: 'Priya', roles: new Set<Role>(['pm']), isActive: true };
  const seats: Record<string, string | undefined> = { 'sub-q3-regional-deck': ids.get('ana@gdp.local'), 'sub-onboarding-guide': ids.get('ben@gdp.local') };
  try {
    for (const fixture of fixtures) {
      const row = await syncSubmission(fixture.id, ids.get('admin@gdp.local') ?? null);
      const holder = seats[fixture.id];
      const current = (await database.select().from(submissionsTable).where(eq(submissionsTable.id, row.id)).limit(1))[0]!;
      if (holder && current.rubricAssigneeId === null) await assignSeat(pm, row.id, 'rubric', holder);
      console.log(`Imported ${fixture.id} → /submissions/${row.id}${holder ? ' (rubric seat assigned)' : ''}`);
    }
  } catch (error) {
    console.warn(`Could not import fixture submissions: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`Is the mock Catalog running (npm run mock:catalog) and WIRESTOCK_API_BASE_URL=http://localhost:4010 set? You can also import later from the Tasks page.`);
  }

  // 4. AI output files for manual upload
  const dir = path.join(process.cwd(), 'fixtures', 'ai-outputs');
  await mkdir(dir, { recursive: true });
  for (const fixture of fixtures) {
    for (const f of fixture.aiOutputs) await writeFile(path.join(dir, `${fixture.id}__${f.name}`), await f.build());
  }
  console.log(`AI output files written to ${dir} — upload them on the task page as "AI output".`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
