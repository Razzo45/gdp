import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { normalizeClaim, tagForStoredFamily } from '@/domain/legacyImport';
import { FAMILIES, type Family } from '@/domain/rubric';

/**
 * Read-only from live Supabase rubric runs. Writes family/tag on Railway
 * current statements only. Never writes to Supabase or Neon.
 *
 *   npx railway run --service Postgres -- npx tsx scripts/restore-rubric-families.ts --apply
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

function asFamily(value: unknown): Family | null {
  const family = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (FAMILIES as readonly string[]).includes(family) ? (family as Family) : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const env = parseDotenv(path.join(process.cwd(), '.env.local'));
  const url = env.get('SUPABASE_READ_URL') || env.get('NEXT_PUBLIC_SUPABASE_URL');
  const key = env.get('SUPABASE_READ_SERVICE_ROLE_KEY') || env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('No Supabase read credentials in .env.local');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const sql = postgres(railwayUrl(), { max: 1, prepare: false, ssl: 'require', connection: { application_name: 'gdp-restore-families' } });

  try {
    const tasks = await sql<{ id: string; catalog: string; title: string }[]>`
      select id, catalog_submission_id as catalog, title from app.submissions order by title
    `;
    let updated = 0;
    let unmatched = 0;
    for (const task of tasks) {
      const live = await supabase.from('wirestock_submissions').select('id').eq('submission_id', task.catalog).maybeSingle();
      if (live.error) throw new Error(live.error.message);
      if (!live.data?.id) {
        console.log(`skip ${task.catalog}: not on live`);
        continue;
      }
      const runs = await supabase.from('wirestock_rubric_runs').select('rows, created_at').eq('submission_id', live.data.id).order('created_at', { ascending: false }).limit(3);
      if (runs.error) throw new Error(runs.error.message);
      const rows = (runs.data ?? []).flatMap((run) => (Array.isArray(run.rows) ? run.rows : []));
      const latestRows = Array.isArray(runs.data?.[0]?.rows) ? (runs.data?.[0]?.rows as unknown[]) : [];
      const byText = new Map<string, Family>();
      const byPosition = new Map<number, Family>();
      latestRows.forEach((row, index) => {
        if (!row || typeof row !== 'object') return;
        const rec = row as Record<string, unknown>;
        const family = asFamily(rec.family);
        if (family) byPosition.set(index, family);
      });
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const rec = row as Record<string, unknown>;
        const family = asFamily(rec.family);
        const statement = String(rec.statement ?? rec.text ?? rec.question ?? '');
        if (!family || statement.length < 8) continue;
        const key = normalizeClaim(statement);
        if (!byText.has(key)) byText.set(key, family);
      }
      const current = (
        await sql<{ id: string; statement: string; family: string; tag: string; position: number }[]>`
          select s.id, s.statement, s.family, s.tag, s.position
          from app.rubric_statements s
          join app.rubrics r on r.id = s.rubric_id
          where r.submission_id = ${task.id} and r.is_current
          order by s.position
        `
      );
      const before = { format: 0, content: 0, visual: 0 };
      const after = { format: 0, content: 0, visual: 0 };
      let hit = 0;
      for (const statement of current) {
        before[statement.family as Family] += 1;
        const family = byText.get(normalizeClaim(statement.statement))
          ?? (byPosition.size === current.length
            ? byPosition.get(statement.position) ?? byPosition.get(statement.position - 1)
            : undefined);
        if (!family) {
          after[statement.family as Family] += 1;
          unmatched += 1;
          continue;
        }
        after[family] += 1;
        if (family === statement.family) {
          hit += 1;
          continue;
        }
        const tag = tagForStoredFamily(family, statement.statement);
        if (apply) {
          await sql`update app.rubric_statements set family = ${family}, tag = ${tag} where id = ${statement.id}`;
        }
        updated += 1;
        hit += 1;
      }
      console.log(`${apply ? 'fixed' : 'would fix'} ${task.catalog.slice(0, 8)} ${current.length} statements match=${hit} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    console.log(`${apply ? 'updated' : 'would update'} ${updated} statements; unmatched ${unmatched}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
