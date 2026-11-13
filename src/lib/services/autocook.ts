import 'server-only';

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { submissionEvents } from '@/db/schema';
import { brainFromModelTag, cookPromptFromFields, mediaPathFromAbs } from '@/domain/autocook';
import { canAutocook, type Actor, type SeatView } from '@/lib/auth/permissions';
import { autocookConfigured, env } from '@/lib/env';
import { normaliseMime } from '@/lib/ai/media';
import { addAiOutput, catalogSourceFiles, listAiOutputs, removeAiOutput } from './files';
import { conflict, forbidden, invalid, ServiceError } from './errors';
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

async function latestCookEvent(submissionId: string, action: string): Promise<{ runId: string; detail: Record<string, unknown> } | null> {
  const row = (
    await db()
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

async function ingestRun(actor: Actor, submissionId: string, runId: string, detail: AutocookRunDetail): Promise<{ id: string; name: string }[]> {
  const already = await latestCookEvent(submissionId, 'autocook_ingested');
  if (already?.runId === runId) {
    const files = await listAiOutputs(db(), submissionId);
    return files.map((f) => ({ id: f.id, name: f.name }));
  }

  const paths = deliverablePaths(detail);
  if (!paths.length) throw new ServiceError(502, 'Autocook finished but returned no downloadable files.');

  const existing = await listAiOutputs(db(), submissionId);
  for (const file of existing) {
    await removeAiOutput(actor, submissionId, file.id);
  }

  const attached: { id: string; name: string }[] = [];
  for (const item of paths.slice(0, 8)) {
    const downloaded = await downloadDeliverable(item.path);
    const row = await addAiOutput(actor, submissionId, {
      name: item.name,
      mime: normaliseMime(item.name, downloaded.mime),
      bytes: downloaded.bytes,
    });
    attached.push({ id: row.id, name: row.name });
  }

  await recordEvent(db(), submissionId, actor.id, 'autocook_ingested', {
    runId,
    files: attached.map((f) => f.name),
  });
  return attached;
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
  const inputs = await catalogSourceFiles(submission, 'inputs');

  const form = new FormData();
  form.set('prompt', prompt);
  form.set('brain', brain);
  form.set('requestId', `gdp:${submissionId}:${Date.now()}`);
  form.set('sessionLabel', `GDP ${submission.catalogSubmissionId.slice(0, 8)}`);
  for (const file of inputs.files) {
    const part = new Blob([Buffer.from(file.bytes)], { type: file.mime });
    form.append('inputs', part, file.name);
  }

  const res = await fetch(`${baseUrl()}/api/cook`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
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
    const files = await ingestRun(actor, submissionId, runId, detail);
    return { runId, status, live: live || 'Done', progress: 100, error: null, files, ingested: true };
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
