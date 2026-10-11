import './env';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';

/**
 * Read-only copy of live platform tasks into tmp/supabase-snapshot/.
 * Prefers the Supabase API (project URL + service role from Replit).
 * Falls back to a Postgres URI. Never uses local DATABASE_URL. Never writes.
 */
const OUT = path.join(process.cwd(), 'tmp', 'supabase-snapshot');
const PAGE = 1000;

const LEGACY = [
  'profiles',
  'roles',
  'user_roles',
  'role_permissions',
  'permissions',
  'watched_projects',
  'wirestock_project_features',
  'wirestock_project_watches',
  'wirestock_submissions',
  'wirestock_submission_states',
  'wirestock_rubric_runs',
  'wirestock_rubric_grades',
  'wirestock_calibrations',
  'wirestock_quality_results',
  'wirestock_reviews_v1',
  'wirestock_review_feedback',
  'wirestock_submission_assignments',
  'wirestock_submission_handoffs',
  'wirestock_rubric_answers',
  'wirestock_submission_reviews',
  'local_stability_results',
  'local_stability_jobs',
] as const;

const APP = ['watched_projects', 'submissions', 'rubrics', 'rubric_statements', 'golden_ratings', 'calibrations', 'review_feedback', 'stability_passes', 'stability_acceptances'] as const;

type Index = { pulledAt: string; via: 'api' | 'postgres'; tables: string[]; counts: Record<string, number>; tasks: unknown[] };

async function main() {
  await mkdir(OUT, { recursive: true });
  const apiUrl = (process.env['SUPABASE_READ_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'])?.trim();
  const apiKey = (process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'])?.trim();
  const pgUrl = process.env['SUPABASE_READ_DATABASE_URL']?.trim();

  let index: Index;
  if (apiUrl && apiKey) {
    index = await viaApi(apiUrl, apiKey);
  } else if (pgUrl) {
    if (pgUrl === process.env['DATABASE_URL']?.trim()) {
      console.error('Refusing: SUPABASE_READ_DATABASE_URL matches local DATABASE_URL.');
      process.exit(2);
    }
    index = await viaPostgres(pgUrl);
  } else {
    console.error('No live Supabase read credentials.');
    console.error('From the Replit app secrets, copy these into .env.local (do not paste them in chat):');
    console.error('  SUPABASE_READ_URL=https://<project>.supabase.co');
    console.error('  SUPABASE_READ_SERVICE_ROLE_KEY=<the SUPABASE_SERVICE_ROLE_KEY secret>');
    console.error('Do not reset the database password.');
    process.exit(2);
  }

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Read-only snapshot via ${index.via} → ${OUT}`);
  console.log(`Tables: ${Object.entries(index.counts).map(([k, n]) => `${k}=${n}`).join(', ') || '(none of the known task tables)'}`);
  console.log(`Tasks: ${index.tasks.length}`);
}

async function viaApi(url: string, key: string): Promise<Index> {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const index: Index = { pulledAt: new Date().toISOString(), via: 'api', tables: [], counts: {}, tasks: [] };
  const dumped = new Map<string, Record<string, unknown>[]>();

  for (const name of LEGACY) {
    const rows = await selectAll(client, 'public', name);
    if (rows === null) continue;
    dumped.set(`public.${name}`, rows);
    index.tables.push(`public.${name}`);
    index.counts[`public.${name}`] = rows.length;
    await writeFile(path.join(OUT, `public.${name}.json`), JSON.stringify(rows, null, 2));
  }
  for (const name of APP) {
    const rows = await selectAll(client, 'app', name);
    if (rows === null) continue;
    dumped.set(`app.${name}`, rows);
    index.tables.push(`app.${name}`);
    index.counts[`app.${name}`] = rows.length;
    await writeFile(path.join(OUT, `app.${name}.json`), JSON.stringify(rows, null, 2));
  }

  const submissions = dumped.get('public.wirestock_submissions');
  if (submissions) {
    const states = new Map((dumped.get('public.wirestock_submission_states') ?? []).map((s) => [String(s['submission_id']), s]));
    const runs = dumped.get('public.wirestock_rubric_runs') ?? [];
    index.tasks = submissions
      .map((w) => {
        const payload = isRecord(w['submission']) ? w['submission'] : {};
        return {
          catalog_id: w['submission_id'],
          project_id: w['project_id'],
          title: payload['title'] ?? payload['name'] ?? '',
          state: states.get(String(w['id']))?.['state'] ?? null,
          rubric_runs: runs.filter((r) => r['submission_id'] === w['id']).length,
          last_seen_at: w['last_seen_at'],
        };
      })
      .sort((a, b) => String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')));
  } else {
    const appSubs = dumped.get('app.submissions');
    if (appSubs) {
      index.tasks = appSubs
        .map((s) => ({
          catalog_id: s['catalog_submission_id'],
          project_id: s['project_id'],
          title: s['title'],
          stage: s['stage'],
          last_seen_at: s['last_seen_at'],
        }))
        .sort((a, b) => String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')));
    }
  }
  return index;
}

async function selectAll(client: SupabaseClient, schema: string, table: string): Promise<Record<string, unknown>[] | null> {
  const from = schema === 'public' ? client.from(table) : client.schema(schema).from(table);
  const rows: Record<string, unknown>[] = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
    const { data, error } = await from.select('*').range(fromRow, fromRow + PAGE - 1);
    if (error) {
      if (missingTable(error.message)) return null;
      throw new Error(`${schema}.${table}: ${error.message}`);
    }
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

function missingTable(message: string): boolean {
  return /could not find the table|schema cache|does not exist|Invalid schema|PGRST205|PGRST106/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function viaPostgres(url: string): Promise<Index> {
  const sql = postgres(url, { max: 1, prepare: false, ssl: 'require', connection: { application_name: 'gdp-snapshot-readonly' } });
  try {
    return await sql.begin(async (tx) => {
      await tx`set transaction read only`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select table_schema as schema, table_name as name
        from information_schema.tables
        where table_schema in ('app', 'public') and table_type = 'BASE TABLE'
        order by 1, 2
      `;
      const have = new Set(tables.map((t) => `${t.schema}.${t.name}`));
      const next: Index = { pulledAt: new Date().toISOString(), via: 'postgres', tables: [...have].sort(), counts: {}, tasks: [] };
      for (const name of LEGACY) {
        if (!have.has(`public.${name}`)) continue;
        const rows = await tx`select * from ${tx('public')}.${tx(name)}`;
        await writeFile(path.join(OUT, `public.${name}.json`), JSON.stringify(rows, null, 2));
        next.counts[`public.${name}`] = rows.length;
      }
      for (const name of APP) {
        if (!have.has(`app.${name}`)) continue;
        const rows = await tx`select * from ${tx('app')}.${tx(name)}`;
        await writeFile(path.join(OUT, `app.${name}.json`), JSON.stringify(rows, null, 2));
        next.counts[`app.${name}`] = rows.length;
      }
      if (have.has('public.wirestock_submissions')) {
        next.tasks = [...(await tx`
          select
            w.submission_id as catalog_id,
            w.project_id,
            coalesce(w.submission->>'title', w.submission->>'name', '') as title,
            s.state,
            (select count(*)::int from public.wirestock_rubric_runs r where r.submission_id = w.id) as rubric_runs,
            w.last_seen_at
          from public.wirestock_submissions w
          left join public.wirestock_submission_states s on s.submission_id = w.id
          order by w.last_seen_at desc nulls last
        `)];
      } else if (have.has('app.submissions')) {
        next.tasks = [...(await tx`
          select catalog_submission_id as catalog_id, project_id, title, stage, last_seen_at
          from app.submissions
          order by last_seen_at desc nulls last
        `)];
      }
      return next;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
