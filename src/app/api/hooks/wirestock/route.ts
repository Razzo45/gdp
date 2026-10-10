import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { json } from '@/lib/api';
import { readSignature, signatureMatches, timestampFresh } from '@/lib/catalog/webhook';
import { env } from '@/lib/env';
import { syncSubmission, watchedProjectFor } from '@/lib/services/submissions';

/**
 * Catalog deliveries: "submission X in project Y changed status".
 *
 * Public endpoint; the HMAC signature over `<timestamp>.<raw body>` is the
 * whole authentication and is checked before the body is parsed. The body
 * carries no submission — only ids — so this is a trigger: we read the
 * submission ourselves with our own token, and only for watched projects.
 * Delivery is at-least-once; the event id is unique, and transient failures
 * answer 5xx so the sender retries.
 */

export const dynamic = 'force-dynamic';

const Delivery = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  occurredAt: z.string().optional(),
  projectId: z.string().optional(),
  submissionId: z.string().min(1),
  status: z.string().optional(),
});

const ACTED_ON = new Set(['submission.status-changed', 'submission.created']);
const MAX_BODY = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const secret = env().WIRESTOCK_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'This endpoint is not configured.' }, 500);

  const claimed = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(claimed) && claimed > MAX_BODY) return json({ error: 'That delivery is too large.' }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ error: 'That delivery is too large.' }, 413);

  const signature = readSignature(request.headers.get('x-wirestock-signature'));
  const timestamp = request.headers.get('x-wirestock-timestamp') ?? '';
  if (!signature) return json({ error: 'Missing or malformed signature.' }, 401);
  if (!timestampFresh(timestamp)) return json({ error: 'Stale or missing timestamp.' }, 401);
  if (!signatureMatches(signature.digest, body, timestamp, secret)) {
    console.warn(`[wirestock webhook] refused: signature mismatch (keyId=${signature.keyId})`);
    return json({ error: 'Signature does not match.' }, 401);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return json({ error: 'Signed, but not valid JSON.' }, 400);
  }
  const parsed = Delivery.safeParse(decoded);
  if (!parsed.success) return json({ error: 'Signed, but not a delivery we understand.' }, 400);
  const event = parsed.data;

  const database = db();
  const inserted = await database
    .insert(webhookEvents)
    .values({ eventId: event.eventId, eventType: event.eventType, submissionId: event.submissionId, projectId: event.projectId ?? '', statusId: event.status ?? '', occurredAt: event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt)) ? new Date(event.occurredAt).toISOString() : null })
    .onConflictDoNothing()
    .returning({ eventId: webhookEvents.eventId });
  if (inserted.length === 0) return json({ ok: true, outcome: 'duplicate' });

  const outcome = async (value: string, detail = '') => {
    await database.update(webhookEvents).set({ outcome: value, detail }).where(eq(webhookEvents.eventId, event.eventId));
  };

  if (!ACTED_ON.has(event.eventType)) {
    await outcome('ignored', 'event type not acted on');
    return json({ ok: true, outcome: 'ignored' });
  }
  if (!event.projectId || !(await watchedProjectFor(database, event.projectId))) {
    await outcome('ignored', 'project not watched');
    return json({ ok: true, outcome: 'ignored' });
  }

  try {
    const submission = await syncSubmission(event.submissionId, null);
    await outcome('synced', submission.id);
    return json({ ok: true, outcome: 'synced' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await outcome('failed', message);
    // 5xx so the Catalog retries; a 404 from them is final.
    const status = (error as { status?: number }).status === 404 ? 200 : 502;
    return json({ ok: status === 200, outcome: 'failed', error: message }, status);
  }
}
