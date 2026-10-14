import './env';
import { db } from '@/db/client';
import { migrate } from '@/db/migrate';

/** `npm run db:migrate` — applies drizzle/*.sql forward-only against DATABASE_URL. */
async function main() {
  const url = process.env['DATABASE_URL'] ?? '';
  if (/supabase\.(co|com)/i.test(url)) throw new Error('Refusing to migrate live Supabase.');
  if (url.startsWith('pglite:')) throw new Error('Refusing to migrate a PGlite sandbox. Unset DATABASE_URL so .env.local is used.');
  const ran = await migrate(db());
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
