import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissionEvents } from '@/db/schema';
import {
  applyCookActivity,
  brainFromModelTag,
  canAutocookEmail,
  closeBlocksCookWatch,
  COOK_ACTIVITY_ACTIONS,
  cookPromptFromFields,
  ingestFilePlan,
  landedCookFiles,
  mediaPathFromAbs,
  operatorCookFromRun,
  sortOperatorCooks,
  type CookActivityEvent,
  type OperatorCookRow,
} from '@/domain/autocook';
import { actorById } from '@/lib/auth/identity';
import { canAutocook, type Actor, type SeatView } from '@/lib/auth/permissions';
import { autocookConfigured, env } from '@/lib/env';
import { normaliseMime } from '@/lib/ai/media';
import type { DbOrTx } from '@/db/types';
import { discardStoredObjects, catalogSourceLocations, listAiOutputs, writeCookOutputs } from './files';
import { conflict, forbidden, invalid, notFound, ServiceError } from './errors';
import { getVisibleSubmission, readSource, recordEvent } from './submissions';

const SERVICE_STATUSES = new Set([400, 403, 404, 409, 422, 502, 503]);

function serviceStatus(code: number): 400 | 403 | 404 | 409 | 422 | 502 | 503 {
  return SERVICE_STATUSES.has(code) ? (code as 400 | 403 | 404 | 409 | 422 | 502 | 503) : 502;
}

export interface AutocookStatus {
  runId: string | null;
  status: string | null;
  live: string | null;
  progress: number | null;
  error: string | null;
  files: { id: string; name: string }[];
  ingested: boolean;
}

type AutocookRunDetail = {
  run?: { id?: string; status?: string; error?: string | null };
  live?: { text?: string } | null;
  deliverables?: Array<{ id?: string; label?: string; path?: string }>;
  finalPath?: string | null;
  error?: string;
};

function assertCookAllowed(actor: Actor, seat: SeatView): void {
  if (!autocookConfigured()) throw invalid('Autocook is not configured on this GDP instance.');
  if (!canAutocook(actor, seat)) throw forbidden('Cook is only available for the operator on rubric-stage tasks.');
}

function authHeaders(): HeadersInit {
  const token = env().AUTOCOOK_SERVICE_TOKEN?.trim();
  if (!token) throw invalid('Autocook is not configured on this GDP instance.');
  return {
    Authorization: `Bearer ${token}`,
    'X-User-Id': 'gdp:george',
  };
}

function baseUrl(): string {
  return env().AUTOCOOK_BASE_URL.replace(/\/$/, '');
}

async function latestCookEvent(
  submissionId: string,
  action: string,
  database: DbOrTx = db(),
): Promise<{ runId: string; detail: Record<string, unknown> } | null> {
  const row = (
    await database
      .select()
      .from(submissionEvents)
      .where(and(eq(submissionEvents.submissionId, submissionId), eq(submissionEvents.action, action)))
      .orderBy(desc(submissionEvents.id))
      .limit(1)
  )[0];
  if (!row) return null;
  const runId = typeof row.detail?.['runId'] === 'string' ? row.detail['runId'] : null;
  if (!runId) return null;
  return { runId, detail: row.detail ?? {} };
}

async function closeCookIngest(actor: Actor, submissionId: string, runId: string): Promise<void> {
  const closed = await latestCookEvent(submissionId, 'autocook_closed');
  const closedStatus = typeof closed?.detail?.['status'] === 'string' ? closed.detail['status'] : null;
  if (closeBlocksCookWatch(closed ? { runId: closed.runId, status: closedStatus } : null, runId)) return;
  await recordEvent(db(), submissionId, actor.id, 'autocook_closed', { runId, status: 'exported' });
}

async function fetchRun(runId: string): Promise<AutocookRunDetail> {
  const res = await fetch(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as AutocookRunDetail;
  if (!res.ok) throw new ServiceError(serviceStatus(res.status), json.error || `Autocook returned ${res.status}.`);
  return json;
}

function deliverablePaths(detail: AutocookRunDetail): { name: string; path: string }[] {
  const fromList = (detail.deliverables ?? [])
    .map((item) => {
      const abs = item.path?.trim();
      if (!abs) return null;
      const name = abs.replaceAll('\\', '/').split('/').pop() || item.label || item.id || 'deliverable';
      return { name, path: mediaPathFromAbs(abs) };
    })
    .filter((item): item is { name: string; path: string } => Boolean(item));
  if (fromList.length) return fromList;
  const finalAbs = detail.finalPath?.trim();
  if (!finalAbs) return [];
  const name = finalAbs.replaceAll('\\', '/').split('/').pop() || 'deliverable';
  return [{ name, path: mediaPathFromAbs(finalAbs) }];
}

async function downloadDeliverable(relPath: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const url = `${baseUrl()}/api/media?path=${encodeURIComponent(relPath)}&download=1`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new ServiceError(502, `Could not download Autocook file (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.byteLength) throw new ServiceError(502, 'Autocook returned an empty file.');
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  return { bytes, mime };
}

const ingesting = new Map<string, Promise<{ files: { id: string; name: string }[]; changed: boolean }>>();

async function ingestRun(
  actor: Actor,
  submissionId: string,
  runId: string,
  detail: AutocookRunDetail,
): Promise<{ files: { id: string; name: string }[]; changed: boolean }> {
  const key = `${submissionId}:${runId}`;
  const pending = ingesting.get(key);
  if (pending) return pending;
  const work = ingestRunOnce(actor, submissionId, runId, detail);
  ingesting.set(key, work);
  try {
    return await work;
  } finally {
    if (ingesting.get(key) === work) ingesting.delete(key);
  }
}

function outputName(name: string): string {
  return name.replace(/[\\/]/g, '_').trim().slice(0, 200);
}

async function ingestRunOnce(
  actor: Actor,
  submissionId: string,
  runId: string,
  detail: AutocookRunDetail,
): Promise<{ files: { id: string; name: string }[]; changed: boolean }> {
  const paths = deliverablePaths(detail);
  if (!paths.length) throw new ServiceError(502, 'Autocook finished but returned no downloadable files.');
  const wanted = paths.map((item) => item.name);
  const byName = new Map(paths.map((item) => [outputName(item.name), item]));

  const previewEvent = await latestCookEvent(submissionId, 'autocook_ingested');
  const previewExisting = await listAiOutputs(db(), submissionId);
  const previewSame = previewEvent?.runId === runId;
  const preview = ingestFilePlan(previewExisting, wanted, previewSame, landedCookFiles(previewEvent?.detail));
  if (preview.add.length === 0 && preview.removeIds.length === 0) {
    if (previewSame) await closeCookIngest(actor, submissionId, runId);
    return { files: previewExisting.map((file) => ({ id: file.id, name: file.name })), changed: false };
  }

  const downloaded = new Map<string, { name: string; mime: string; bytes: Uint8Array }>();
  const failed: string[] = [];
  for (const name of preview.add) {
    const item = byName.get(name);
    if (!item) {
      failed.push(name);
      continue;
    }
    try {
      const file = await downloadDeliverable(item.path);
      downloaded.set(name, { name: item.name, mime: normaliseMime(item.name, file.mime), bytes: file.bytes });
    } catch (error) {
      failed.push(name);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[autocook-ingest] ${runId} ${name}: ${message}`);
    }
  }

  // One task at a time. A second poll waits, then sees the names already stored and does not append.
  const outcome = await db().transaction(async (tx) => {
    await tx.execute(sql`select id from app.submissions where id = ${submissionId}::uuid for update`);
    const already = await latestCookEvent(submissionId, 'autocook_ingested', tx);
    const existing = await listAiOutputs(tx, submissionId);
    const plan = ingestFilePlan(existing, wanted, already?.runId === runId, landedCookFiles(already?.detail));
    const wrote = await writeCookOutputs(tx, actor, submissionId, {
      removeIds: plan.removeIds,
      add: plan.add.flatMap((name) => {
        const file = downloaded.get(name);
        return file ? [file] : [];
      }),
    });
    const changed = wrote.removedPaths.length > 0 || wrote.added > 0;
    if (changed) {
      await recordEvent(tx, submissionId, actor.id, 'autocook_ingested', {
        runId,
        files: wrote.files.map((file) => file.name),
      });
    }
    return { files: wrote.files, changed, removedPaths: wrote.removedPaths, missing: plan.add.filter((name) => !downloaded.has(name)) };
  });

  await discardStoredObjects(outcome.removedPaths);
  const landed = outcome.files.some((file) => byName.has(file.name));
  const missing = [...new Set([...failed, ...outcome.missing])];
  if (missing.length && !landed) throw new ServiceError(502, `Could not attach ${missing.join(', ')}.`);
  if (missing.length === 0) await closeCookIngest(actor, submissionId, runId);
  return { files: outcome.files, changed: outcome.changed };
}

function progressOf(status: string | null | undefined): number | null {
  if (!status) return null;
  if (status === 'exported') return 100;
  if (status === 'failed' || status === 'rejected') return null;
  if (status === 'queued' || status === 'plan' || status === 'argon_plan') return 15;
  if (/generat|deliver|render|export/i.test(status)) return 60;
  return 35;
}

/** Start an Autocook task run from this submission’s brief + Catalog inputs. */
export async function startAutocook(actor: Actor, submissionId: string): Promise<{ runId: string }> {
  const submission = await getVisibleSubmission(db(), actor, submissionId);
  assertCookAllowed(actor, submission);

  const active = await latestCookEvent(submissionId, 'autocook_started');
  if (active) {
    const ingested = await latestCookEvent(submissionId, 'autocook_ingested');
    if (ingested?.runId !== active.runId) {
      try {
        const detail = await fetchRun(active.runId);
        const status = detail.run?.status ?? null;
        if (status && !['exported', 'failed', 'rejected'].includes(status)) {
          throw conflict('A cook is already running for this task.');
        }
        // Finished on Autocook but not ingested yet — hand the run back so the client can poll/ingest.
        if (status === 'exported') return { runId: active.runId };
      } catch (error) {
        if (error instanceof ServiceError && error.status === 409) throw error;
      }
    }
  }

  const read = readSource(submission);
  if (!read) throw new ServiceError(502, 'The Catalog brief could not be read.');
  const prompt = cookPromptFromFields(read.fields);
  if (!prompt.trim()) throw invalid('This task has no brief text to cook.');

  const brain = brainFromModelTag(submission.modelTag);
  const sources = await catalogSourceLocations(submission, 'inputs');

  const res = await fetch(`${baseUrl()}/api/cook`, {
    method: 'POST',
    headers: { ...(authHeaders() as Record<string, string>), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      brain,
      requestId: `gdp:${submissionId}:${Date.now()}`,
      sessionLabel: `GDP ${submission.catalogSubmissionId.slice(0, 8)}`,
      sources,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; run?: { id?: string }; blocked?: boolean };
  if (!res.ok || json.error) throw new ServiceError(serviceStatus(res.status), json.error || `Autocook cook failed (${res.status}).`);
  if (json.blocked) throw conflict('Autocook blocked this cook. Open Autocook and check the preflight notes.');
  const runId = json.run?.id?.trim();
  if (!runId) throw new ServiceError(502, 'Autocook started but returned no run id.');

  await recordEvent(db(), submissionId, actor.id, 'autocook_started', { runId, brain });
  return { runId };
}

/** Poll Autocook; when exported, replace AI outputs with the deliverables. */
export async function autocookStatus(actor: Actor, submissionId: string, runIdHint?: string): Promise<AutocookStatus> {
  const submission = await getVisibleSubmission(db(), actor, submissionId);
  assertCookAllowed(actor, submission);

  const started = await latestCookEvent(submissionId, 'autocook_started');
  const runId = runIdHint?.trim() || started?.runId || null;
  if (!runId) {
    return { runId: null, status: null, live: null, progress: null, error: null, files: [], ingested: false };
  }

  const detail = await fetchRun(runId);
  const status = detail.run?.status ?? null;
  const live = detail.live?.text?.trim() || detail.run?.error?.trim() || null;
  const failed = status === 'failed' || status === 'rejected';
  if (failed) {
    return {
      runId,
      status,
      live,
      progress: null,
      error: detail.run?.error || live || 'Autocook failed.',
      files: [],
      ingested: false,
    };
  }

  if (status === 'exported') {
    const closed = await latestCookEvent(submissionId, 'autocook_closed');
    const closedStatus = typeof closed?.detail?.['status'] === 'string' ? closed.detail['status'] : null;
    if (closeBlocksCookWatch(closed ? { runId: closed.runId, status: closedStatus } : null, runId)) {
      const files = (await listAiOutputs(db(), submissionId)).map((file) => ({ id: file.id, name: file.name }));
      return { runId, status, live: live || 'Done', progress: 100, error: null, files, ingested: true };
    }
    const ingested = await ingestRun(actor, submissionId, runId, detail);
    return { runId, status, live: live || 'Done', progress: 100, error: null, files: ingested.files, ingested: true };
  }

  return {
    runId,
    status,
    live,
    progress: progressOf(status),
    error: null,
    files: [],
    ingested: false,
  };
}

function assertOperator(actor: Actor): void {
  if (!canAutocookEmail(actor.email)) throw forbidden('Cooks are only available to the operator.');
  if (!autocookConfigured()) throw invalid('Autocook is not configured on this GDP instance.');
}

async function cookActivityEvents(runIds: string[]): Promise<CookActivityEvent[]> {
  if (runIds.length === 0) return [];
  const rows = await db()
    .select({
      action: submissionEvents.action,
      detail: submissionEvents.detail,
      createdAt: submissionEvents.createdAt,
    })
    .from(submissionEvents)
    .where(
      and(
        inArray(submissionEvents.action, [...COOK_ACTIVITY_ACTIONS]),
        sql`${submissionEvents.detail}->>'runId' in (${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(submissionEvents.id))
    .limit(2000);
  return rows.flatMap((row) => {
    const runId = typeof row.detail?.['runId'] === 'string' ? row.detail['runId'].trim() : '';
    return runId ? [{ runId, action: row.action, createdAt: row.createdAt }] : [];
  });
}

/** The operator's own cooks, active first. Opening a task does not move them. */
export async function listOperatorCooks(actor: Actor): Promise<OperatorCookRow[]> {
  assertOperator(actor);
  const res = await fetch(`${baseUrl()}/api/runs`, { headers: authHeaders(), cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as { runs?: unknown; error?: string };
  if (!res.ok) throw new ServiceError(serviceStatus(res.status), json.error || `Autocook returned ${res.status}.`);
  const rows = Array.isArray(json.runs) ? json.runs : [];
  const cooks = rows
    .map((row) => (row && typeof row === 'object' ? operatorCookFromRun(row as Parameters<typeof operatorCookFromRun>[0]) : null))
    .filter((row): row is OperatorCookRow => row !== null);
  const events = await cookActivityEvents(cooks.map((cook) => cook.id));
  return sortOperatorCooks(applyCookActivity(cooks, events));
}

/** Removes one of the operator's cooks. Same call as Delete on the Autocook run page. */
export async function cancelOperatorCook(actor: Actor, runId: string): Promise<void> {
  assertOperator(actor);
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(runId)) throw invalid('Unknown cook.');
  const res = await fetch(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (res.status === 404) throw notFound('That cook');
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ServiceError(serviceStatus(res.status), json.error || `Autocook returned ${res.status}.`);
  }
}

/** Queues a failed cook again. Finished files stay; only the missing ones are written. */
export async function retryOperatorCook(actor: Actor, runId: string): Promise<void> {
  assertOperator(actor);
  if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(runId)) throw invalid('Unknown cook.');
  const res = await fetch(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'retry' }),
    cache: 'no-store',
  });
  if (res.status === 404) throw notFound('That cook');
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ServiceError(serviceStatus(res.status), json.error || `Autocook returned ${res.status}.`);
  }
  const prior = (
    await db()
      .select({
        submissionId: submissionEvents.submissionId,
        actorId: submissionEvents.actorId,
      })
      .from(submissionEvents)
      .where(and(eq(submissionEvents.action, 'autocook_started'), sql`${submissionEvents.detail}->>'runId' = ${runId}`))
      .orderBy(desc(submissionEvents.id))
      .limit(1)
  )[0];
  if (prior) {
    await recordEvent(db(), prior.submissionId, prior.actorId, 'autocook_started', { runId, retry: true });
  }
}

type PendingCook = { submissionId: string; runId: string; actorId: string | null };

/** Latest autocook_started per submission. An exported close leaves the list. A failed close stays, behind cooks that are still open, so a retry of the same run can be attached. */
async function listPendingCookIngests(limit = 20): Promise<PendingCook[]> {
  const rows = await db()
    .select({
      id: submissionEvents.id,
      submissionId: submissionEvents.submissionId,
      actorId: submissionEvents.actorId,
      detail: submissionEvents.detail,
    })
    .from(submissionEvents)
    .where(eq(submissionEvents.action, 'autocook_started'))
    .orderBy(desc(submissionEvents.id))
    .limit(200);

  const seen = new Set<string>();
  const open: PendingCook[] = [];
  const retryable: PendingCook[] = [];
  for (const row of rows) {
    if (seen.has(row.submissionId)) continue;
    seen.add(row.submissionId);
    const runId = typeof row.detail?.['runId'] === 'string' ? row.detail['runId'].trim() : '';
    if (!runId) continue;
    const closed = await latestCookEvent(row.submissionId, 'autocook_closed');
    const closedStatus = typeof closed?.detail?.['status'] === 'string' ? closed.detail['status'] : null;
    if (closeBlocksCookWatch(closed ? { runId: closed.runId, status: closedStatus } : null, runId)) continue;
    const item = { submissionId: row.submissionId, runId, actorId: row.actorId };
    if (closed?.runId === runId && (closedStatus === 'failed' || closedStatus === 'rejected')) retryable.push(item);
    else open.push(item);
    if (open.length >= limit) break;
  }
  return [...open, ...retryable].slice(0, limit);
}

/**
 * Background writeback: when Autocook exports, pull deliverables into AI outputs
 * without requiring the task page to be open. Safe to call on an interval.
 * A cook already ingested is checked again; only missing names are added.
 */
export async function reconcilePendingAutocookIngests(): Promise<{
  checked: number;
  ingested: number;
  failed: number;
  skipped: number;
}> {
  if (!autocookConfigured()) return { checked: 0, ingested: 0, failed: 0, skipped: 0 };

  const pending = await listPendingCookIngests();
  let ingested = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of pending) {
    try {
      const detail = await fetchRun(item.runId);
      const status = detail.run?.status ?? null;
      if (status === 'failed' || status === 'rejected') {
        const closed = await latestCookEvent(item.submissionId, 'autocook_closed');
        const closedStatus = typeof closed?.detail?.['status'] === 'string' ? closed.detail['status'] : null;
        if (closed?.runId === item.runId && (closedStatus === 'failed' || closedStatus === 'rejected')) {
          skipped += 1;
          continue;
        }
        await recordEvent(db(), item.submissionId, item.actorId, 'autocook_closed', {
          runId: item.runId,
          status,
          error: detail.run?.error ?? null,
        });
        skipped += 1;
        continue;
      }
      if (status !== 'exported') {
        skipped += 1;
        continue;
      }
      if (!item.actorId) {
        console.warn(`[autocook-ingest] ${item.submissionId} run ${item.runId} has no actor — cannot write AI outputs`);
        failed += 1;
        continue;
      }
      const actor = await actorById(item.actorId);
      if (!actor) {
        console.warn(`[autocook-ingest] actor ${item.actorId} missing for ${item.submissionId}`);
        failed += 1;
        continue;
      }
      const wrote = await ingestRun(actor, item.submissionId, item.runId, detail);
      if (wrote.changed) {
        ingested += 1;
        console.log(`[autocook-ingest] ingested ${item.runId} → ${item.submissionId}`);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[autocook-ingest] ${item.submissionId} ${item.runId}: ${message}`);
    }
  }

  return { checked: pending.length, ingested, failed, skipped };
}
