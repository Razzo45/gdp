import './env';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const LOCAL_EMAIL = /@gdp\.local$/i;
const FIXTURE_PROJECT = 'proj-fixture-deck-qa';
const FIXTURE_TASKS = ['sub-q3-regional-deck', 'sub-onboarding-guide', 'sub-q3-deck-second-pass'];

async function main() {
  const url = process.env['DATABASE_URL']?.trim();
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (/supabase\.(co|com)|pooler\.supabase/i.test(url)) throw new Error('Refusing: DATABASE_URL looks like live Supabase.');

  const sql = postgres(url, { prepare: false, max: 1 });
  const people = await sql`select id, email, display_name from app.profiles order by email`;
  const local = people.filter((row) => LOCAL_EMAIL.test(String(row.email)));
  const live = people.filter((row) => !LOCAL_EMAIL.test(String(row.email)));

  const tasks = await sql`
    select id, catalog_submission_id, project_id, title, stage
    from app.submissions
    order by catalog_submission_id
  `;
  const fixture = tasks.filter(
    (row) =>
      String(row.project_id) === FIXTURE_PROJECT ||
      FIXTURE_TASKS.includes(String(row.catalog_submission_id)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.catalog_submission_id)),
  );

  const watches = await sql`select project_id, label from app.watched_projects`;
  const fixtureWatches = watches.filter((row) => String(row.project_id) === FIXTURE_PROJECT);

  const snapFile = path.join(process.cwd(), 'tmp', 'supabase-snapshot', 'index.json');
  const liveCatalog = new Set<string>();
  if (existsSync(snapFile)) {
    const snap = JSON.parse(readFileSync(snapFile, 'utf8')) as { tasks?: { catalog_id?: string }[] };
    for (const task of snap.tasks ?? []) if (task.catalog_id) liveCatalog.add(task.catalog_id);
  }
  const leftover = liveCatalog.size ? tasks.filter((row) => !liveCatalog.has(String(row.catalog_submission_id))) : [];

  console.log(
    JSON.stringify(
      {
        profiles: { total: people.length, local: local.map((row) => row.email), live: live.length },
        tasks: {
          total: tasks.length,
          liveSnapshot: liveCatalog.size,
          fixture: fixture.map((row) => ({ catalog: row.catalog_submission_id, title: String(row.title).slice(0, 60) })),
          leftover: leftover.map((row) => ({ catalog: row.catalog_submission_id, project: row.project_id, title: String(row.title).slice(0, 70), stage: row.stage })),
        },
        watches: fixtureWatches,
      },
      null,
      2,
    ),
  );

  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Re-run with --apply to delete.');
    await sql.end();
    return;
  }

  const fixtureIds = [...new Set([...fixture, ...leftover].map((row) => String(row.id)))];
  const deletedTasks = fixtureIds.length
    ? await sql`delete from app.submissions where id in ${sql(fixtureIds)} returning catalog_submission_id`
    : [];
  const deletedWatches = await sql`delete from app.watched_projects where project_id = ${FIXTURE_PROJECT} returning project_id`;
  const deletedUsers = await sql`delete from app.profiles where email like '%@gdp.local' returning email`;

  const afterPeople = await sql`select count(*)::int as n from app.profiles`;
  const afterTasks = await sql`select count(*)::int as n from app.submissions`;
  console.log(
    JSON.stringify({
      deletedUsers: deletedUsers.map((row) => row.email),
      deletedTasks: deletedTasks.map((row) => row.catalog_submission_id),
      deletedWatches: deletedWatches.map((row) => row.project_id),
      remainingUsers: afterPeople[0]?.n,
      remainingTasks: afterTasks[0]?.n,
    }),
  );
  await sql.end();
}

void main();
