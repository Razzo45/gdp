import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * One-way copy: Neon app.* (laptop DATABASE_URL) → Railway Postgres.
 * Never writes to Neon. Skips app.schema_migrations. Never touches Supabase.
 *
 *   npx railway run --service Postgres -- npx tsx scripts/clone-neon-to-railway.ts
 *   npx railway run --service Postgres -- npx tsx scripts/clone-neon-to-railway.ts --apply
 */

const SKIP = new Set(['schema_migrations']);
const BATCH = 200;

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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid)';
  }
}

function assertSafe(label: string, url: string, kind: 'neon' | 'railway') {
  const host = hostOf(url);
  if (/supabase\.(co|com)|pooler\.supabase/i.test(host)) throw new Error(`${label} looks like Supabase (${host}). Refusing.`);
  if (kind === 'neon' && !/neon\.tech/i.test(host)) throw new Error(`${label} is ${host}, expected a Neon host.`);
  if (kind === 'railway' && !/rlwy\.net|railway\.(internal|app)/i.test(host)) throw new Error(`${label} is ${host}, expected Railway.`);
}

function neonUrl(): string {
  const local = parseDotenv(path.join(process.cwd(), '.env.local')).get('DATABASE_URL')?.trim();
  if (!local) throw new Error('No DATABASE_URL in .env.local');
  assertSafe('Neon', local, 'neon');
  return local;
}

const dateAsString = {
  to: 1184,
  from: [1082, 1083, 1114, 1184],
  parse: (value: string) => value,
  serialize: (value: unknown) => value,
};

function connect(url: string, name: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl: 'require',
    connection: { application_name: name },
    types: { date: dateAsString },
  });
}

function railwayUrl(): string {
  const host = process.env['PGHOST_PUBLIC']?.trim();
  const port = process.env['PGPORT_PUBLIC']?.trim();
  const user = process.env['PGUSER']?.trim();
  const password = process.env['PGPASSWORD'] ?? '';
  const database = process.env['PGDATABASE']?.trim() || 'railway';
  if (!host || !port || !user) throw new Error('Run via `railway run --service Postgres` so PGHOST_PUBLIC is set.');
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
  assertSafe('Railway', url, 'railway');
  return url;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

async function tableNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'app' and table_type = 'BASE TABLE'
    order by table_name
  `;
  return rows.map((r) => r.table_name);
}

async function columns(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'app' and table_name = ${table}
    order by ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

async function identityAlways(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n
    from information_schema.columns
    where table_schema = 'app' and table_name = ${table} and is_identity = 'YES' and identity_generation = 'ALWAYS'
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function insertBatch(
  tx: postgres.Sql,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  overrideIdentity: boolean,
) {
  if (!rows.length) return;
  if (!overrideIdentity) {
    await tx`insert into app.${tx(table)} ${tx(rows)}`;
    return;
  }
  const colList = columns.map(ident).join(', ');
  const params: Array<string | number | boolean | null> = [];
  const tuples = rows.map((row) => {
    const cells = columns.map((col) => {
      const value = row[col];
      params.push(value === undefined ? null : (value as string | number | boolean | null));
      return `$${params.length}`;
    });
    return `(${cells.join(', ')})`;
  });
  await tx.unsafe(`insert into app.${ident(table)} (${colList}) overriding system value values ${tuples.join(', ')}`, params);
}

async function count(sql: postgres.Sql, table: string): Promise<number> {
  const rows = await sql.unsafe(`select count(*)::int as n from app.${ident(table)}`);
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sourceUrl = neonUrl();
  const destUrl = railwayUrl();
  console.log(`Source Neon ${hostOf(sourceUrl)} → Railway ${hostOf(destUrl)}${apply ? '' : ' (dry-run)'}`);

  const source = connect(sourceUrl, 'gdp-clone-neon-read');
  const dest = connect(destUrl, 'gdp-clone-railway-write');
  try {
    const sourceTables = await tableNames(source);
    const destTables = new Set(await tableNames(dest));
    const copy = sourceTables.filter((name) => destTables.has(name) && !SKIP.has(name));
    const skipped = sourceTables.filter((name) => SKIP.has(name) || !destTables.has(name));

    const destCols = new Map<string, string[]>();
    const destIdentity = new Map<string, boolean>();
    for (const table of destTables) {
      destCols.set(table, await columns(dest, table));
      destIdentity.set(table, await identityAlways(dest, table));
    }
    const plan: { table: string; neon: number; railway: number; columns: string[]; identity: boolean }[] = [];
    for (const table of copy) {
      const destColumns = destCols.get(table) ?? [];
      const shared = (await columns(source, table)).filter((col) => destColumns.includes(col));
      plan.push({
        table,
        neon: await count(source, table),
        railway: await count(dest, table),
        columns: shared,
        identity: destIdentity.get(table) ?? false,
      });
    }

    for (const row of plan) {
      console.log(`${row.table}: neon=${row.neon} railway=${row.railway} cols=${row.columns.length}`);
    }
    if (skipped.length) console.log(`Skip: ${skipped.join(', ')}`);
    console.log(`Total neon rows: ${plan.reduce((n, r) => n + r.neon, 0)}`);

    if (!apply) {
      console.log('Re-run with --apply to write Neon rows onto Railway.');
      return;
    }

    await dest`select set_config('session_replication_role', 'replica', false)`;
    try {
    await dest.begin(async (tx) => {
      for (const row of [...plan].reverse()) {
        await tx.unsafe(`truncate table app.${ident(row.table)} cascade`);
      }
      for (const row of plan) {
        if (row.neon === 0) {
          console.log(`copied ${row.table} 0`);
          continue;
        }
        const colList = row.columns.map(ident).join(', ');
        let offset = 0;
        let copied = 0;
        while (offset < row.neon) {
          const batch = await source.unsafe(`select ${colList} from app.${ident(row.table)} offset ${offset} limit ${BATCH}`);
          if (!batch.length) break;
          const plain = batch.map((item) => Object.fromEntries(row.columns.map((col) => [col, item[col]])));
          await insertBatch(tx as unknown as postgres.Sql, row.table, row.columns, plain, row.identity);
          copied += batch.length;
          offset += batch.length;
        }
        console.log(`copied ${row.table} ${copied}`);
      }
    });
    } finally {
      await dest`select set_config('session_replication_role', 'origin', false)`;
    }

    for (const row of plan.filter((item) => item.identity)) {
      await dest.unsafe(
        `select setval(pg_get_serial_sequence('app.${ident(row.table)}', 'id'), coalesce((select max(id) from app.${ident(row.table)}), 1))`,
      );
    }

    console.log('Verify:');
    for (const row of plan) {
      const after = await count(dest, row.table);
      const mark = after === row.neon ? 'ok' : 'MISMATCH';
      console.log(`${mark} ${row.table}: neon=${row.neon} railway=${after}`);
      if (after !== row.neon) throw new Error(`${row.table} count mismatch`);
    }
    console.log('Railway now matches Neon app.* data.');
  } finally {
    await source.end({ timeout: 5 });
    await dest.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
