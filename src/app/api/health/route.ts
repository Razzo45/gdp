import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { json } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db().execute(sql`select 1`);
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: 'database unreachable' }, 503);
  }
}
