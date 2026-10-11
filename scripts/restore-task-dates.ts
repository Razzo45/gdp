import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

/**
 * Replaces clone/import timestamps with the latest live interaction.
 * Never writes to Supabase.
 *
 *   npx railway run --service Postgres -- npx tsx scripts/restore-task-dates.ts --apply
 */

function parseDotenv(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    map.set(line.slice(0, at).trim(), value);
  }
  return map;
}

function railwayUrl(): string {
  const host = process.env['PGHOST_PUBLIC']?.trim();
  const port = process.env['PGPORT_PUBLIC']?.trim();
  const user = process.env['PGUSER']?.trim();
  const password = process.env['PGPASSWORD'] ?? '';
  const database = process.env['PGDATABASE']?.trim() || 'railway';
  if (!host || !port || !user) throw new Error('Run via `railway run --service Postgres`.');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
}

function latest(values: Array<string | null | undefined>): string | null {
  const times = values.map((v) => (v ? Date.parse(v) : NaN)).filter((n) => Number.isFinite(n));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const env = parseDotenv(path.join(process.cwd(), '.env.local'));
  const url = env.get('SUPABASE_READ_URL') || env.get('NEXT_PUBLIC_SUPABASE_URL');
  const key = env.get('SUPABASE_READ_SERVICE_ROLE_KEY') || env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('No Supabase read credentials');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const sql = postgres(railwayUrl(), { max: 1, prepare: false, ssl: 'require', connection: { application_name: 'gdp-restore-dates' } });
  try {
    const tasks = await sql<
      {
        id: string;
        catalog: string;
        landed_at: string;
        last_seen_at: string;
        last_claimed_at: string | null;
        rubric_assignee_id: string | null;
        reviewer_id: string | null;
      }[]
    >`
      select id, catalog_submission_id as catalog, landed_at::text, last_seen_at::text, last_claimed_at::text,
             rubric_assignee_id, reviewer_id
      from app.submissions
    `;
    let updated = 0;
    for (const task of tasks) {
      const live = await supabase.from('wirestock_submissions').select('id, first_seen_at, last_seen_at, edited_at').eq('submission_id', task.catalog).maybeSingle();
      if (live.error) throw new Error(live.error.message);
      const internal = live.data?.id;
      const points: Array<string | null | undefined> = [live.data?.last_seen_at, live.data?.edited_at];
      let assignAt: string | null = null;
      if (internal) {
        const assigns = await supabase.from('wirestock_submission_assignments').select('created_at, updated_at').eq('submission_id', internal);
        for (const row of assigns.data ?? []) {
          points.push(row.created_at, row.updated_at);
          assignAt = latest([assignAt, row.updated_at, row.created_at]);
        }
        const runs = await supabase.from('wirestock_rubric_runs').select('created_at').eq('submission_id', internal);
        for (const row of runs.data ?? []) points.push(row.created_at);
        for (const table of ['wirestock_submission_reviews', 'wirestock_review_feedback', 'wirestock_reviews_v1'] as const) {
          const rows = await supabase.from(table).select('created_at, updated_at').eq('submission_id', internal);
          if (rows.error) continue;
          for (const row of rows.data ?? []) points.push(row.created_at, row.updated_at as string | undefined);
        }
      }
      const activity = latest(points);
      if (!activity) {
        console.log(`skip ${task.catalog.slice(0, 8)}: no live activity`);
        continue;
      }
      const landed = live.data?.first_seen_at ?? task.landed_at;
      console.log(`${apply ? 'set' : 'would set'} ${task.catalog.slice(0, 8)} last=${activity} landed=${landed}`);
      if (!apply) continue;
      await sql`
        update app.submissions
        set
          landed_at = ${landed},
          last_seen_at = ${activity},
          last_claimed_at = ${assignAt ?? activity},
          updated_at = ${activity},
          rubric_claimed_at = case when rubric_assignee_id is not null then ${assignAt ?? activity} else rubric_claimed_at end,
          review_claimed_at = case when reviewer_id is not null then ${assignAt ?? activity} else review_claimed_at end
        where id = ${task.id}
      `;
      updated += 1;
    }
    console.log(`${apply ? 'updated' : 'would update'} ${updated}/${tasks.length}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
