import './env';

/**
 * When launched via `railway run --service Postgres`, point DATABASE_URL
 * at the public Railway host so local scripts do not write Neon or live Supabase.
 */
const host = process.env['PGHOST_PUBLIC']?.trim();
const port = process.env['PGPORT_PUBLIC']?.trim();
const user = process.env['PGUSER']?.trim();
const password = process.env['PGPASSWORD'] ?? '';
const database = process.env['PGDATABASE']?.trim() || 'railway';
if (host && port && user) {
  if (/supabase\.(co|com)|neon\.tech/i.test(host)) throw new Error(`Refusing unexpected host ${host}`);
  if (!/rlwy\.net|railway\.(internal|app)/i.test(host)) throw new Error(`Not Railway (${host})`);
  process.env['DATABASE_URL'] =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
  console.log(`Target Railway ${host}`);
}
