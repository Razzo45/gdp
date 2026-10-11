import './env';

/**
 * Laptop migrate against Railway Postgres via its TCP proxy.
 * Uses PG* from `railway run --service Postgres` plus PGHOST_PUBLIC / PGPORT_PUBLIC.
 */
const host = process.env['PGHOST_PUBLIC']?.trim();
const port = process.env['PGPORT_PUBLIC']?.trim();
const user = process.env['PGUSER']?.trim();
const password = process.env['PGPASSWORD'] ?? '';
const database = process.env['PGDATABASE']?.trim() || 'railway';
if (host && port && user) {
  process.env['DATABASE_URL'] =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
}

async function main() {
  const { db } = await import('@/db/client');
  const { migrate } = await import('@/db/migrate');
  const ran = await migrate(db());
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
