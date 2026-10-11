import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { json } from '@/lib/api';
import { rendererAvailable } from '@/lib/ai/media';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db().execute(sql`select 1`);
    return json({ ok: true, renderer: await rendererAvailable() });
  } catch {
    return json({ ok: false, renderer: false, error: 'database unreachable' }, 503);
  }
}
