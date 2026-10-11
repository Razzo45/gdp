import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { json } from '@/lib/api';
import { rendererAvailable } from '@/lib/ai/media';
import { geminiConfigured } from '@/lib/ai/gemini';
import { catalogConfigured } from '@/lib/catalog/client';
import { storageDriver } from '@/lib/env';
import { sesConfigured } from '@/lib/mail/ses';

export const dynamic = 'force-dynamic';

export async function GET() {
  const renderer = await rendererAvailable().catch(() => false);
  const extras = () => {
    try {
      return { storage: storageDriver(), gemini: geminiConfigured(), catalog: catalogConfigured(), ses: sesConfigured() };
    } catch {
      return { storage: 'unknown', gemini: false, catalog: false, ses: false };
    }
  };
  try {
    await db().execute(sql`select 1`);
    return json({ ok: true, database: true, renderer, ...extras() });
  } catch {
    return json({ ok: false, database: false, renderer, ...extras(), error: 'database unreachable' }, 503);
  }
}
