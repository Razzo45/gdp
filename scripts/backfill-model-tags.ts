import './env';
import './railway-target';
import { db } from '@/db/client';
import { migrate } from '@/db/migrate';
import { backfillModelTags } from '@/lib/services/submissions';

/** Retag submissions from stored Catalog acceptance criteria. */
async function main() {
  const url = process.env['DATABASE_URL'] ?? '';
  if (/supabase\.(co|com)/i.test(url)) throw new Error('Refusing to write live Supabase.');
  await migrate(db());
  const result = await backfillModelTags();
  console.log(`Model tags: scanned ${result.scanned}, updated ${result.updated}.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
