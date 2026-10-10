import './env';
import { db } from '@/db/client';
import { migrate } from '@/db/migrate';

/** `npm run db:migrate` â€” applies drizzle/*.sql forward-only against DATABASE_URL. */
async function main() {
  const ran = await migrate(db());
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
