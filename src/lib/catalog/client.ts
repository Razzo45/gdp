import 'server-only';

import { z } from 'zod';
import { parseProjectSubmissionList, type ListedCatalogSubmission } from '@/domain/catalogInbound';
import { env } from '@/lib/env';
import { catalogUploadFilename } from './export';
import { ProjectPayload, SubmissionPayload } from './read';

/**
 * HTTP client for the Data Program API. The bearer token carries far more
 * authority than any signed-in user, so it never leaves this process.
 */

export type CatalogError = { ok: false; status: number; error: string; permanent?: boolean; uncertain?: boolean };

const base = () => env().WIRESTOCK_API_BASE_URL.replace(/\/+$/, '');
const token = () => env().WIRESTOCK_API_TOKEN ?? null;
export const catalogConfigured = () => token() !== null;

const NOT_CONFIGURED: CatalogError = { ok: false, status: 503, error: 'The Catalog API is not configured on this server.' };

async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response | CatalogError> {
  const bearer = token();
  if (!bearer) return NOT_CONFIGURED;
  const attempts = init.method && init.method !== 'GET' ? 1 : 3;
  const backoff = [500, 1500];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(`${base()}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', ...(init.headers ?? {}) },
        cache: 'no-store',
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch {
      if (attempt === attempts) return { ok: false, status: 502, error: 'Could not reach the Catalog API.', uncertain: init.method !== undefined && init.method !== 'GET' };
      await new Promise((r) => setTimeout(r, backoff[attempt - 1]));
    }
  }
  return { ok: false, status: 502, error: 'Could not reach the Catalog API.' };
}

const isError = (value: Response | CatalogError): value is CatalogError => !(value instanceof Response);

function refusal(response: Response, what: string): CatalogError {
  if (response.status === 404) return { ok: false, status: 404, error: `The Catalog has no ${what} with that id.`, permanent: true };
  if (response.status === 401 || response.status === 403) return { ok: false, status: 502, error: 'The Catalog refused this server’s token.', permanent: true };
  return { ok: false, status: 502, error: `The Catalog answered ${response.status}.` };
}

export async function fetchProject(projectId: string): Promise<{ ok: true; project: unknown } | CatalogError> {
  const response = await request(`/projects/${encodeURIComponent(projectId)}`);
  if (isError(response)) return response;
  if (!response.ok) return refusal(response, 'project');
  const raw: unknown = await response.json().catch(() => null);
  if (!ProjectPayload.safeParse(raw).success) return { ok: false, status: 502, error: 'The Catalog returned an unexpected project payload.' };
  return { ok: true, project: raw };
}

export async function listProjectSubmissions(projectId: string, page = 1): Promise<{ ok: true; submissions: ListedCatalogSubmission[]; page: number; totalPages: number } | CatalogError> {
  const query = new URLSearchParams({ projectId, page: String(page) });
  const response = await request(`/project-submissions?${query}`);
  if (isError(response)) return response;
  if (!response.ok) return refusal(response, 'project');
  const parsed = parseProjectSubmissionList(await response.json().catch(() => null));
  return { ok: true, ...parsed };
}

export async function listAllProjectSubmissions(projectId: string): Promise<{ ok: true; submissions: ListedCatalogSubmission[] } | CatalogError> {
  const first = await listProjectSubmissions(projectId, 1);
  if (!first.ok) return first;
  const submissions = [...first.submissions];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await listProjectSubmissions(projectId, page);
    if (!next.ok) return next;
    submissions.push(...next.submissions);
  }
  return { ok: true, submissions };
}

export async function fetchSubmission(id: string): Promise<{ ok: true; submission: Record<string, unknown>; project: unknown; projectId: string } | CatalogError> {
  const response = await request(`/project-submissions/${encodeURIComponent(id)}`);
  if (isError(response)) return response;
  if (!response.ok) return refusal(response, 'submission');
  const raw: unknown = await response.json().catch(() => null);
  const parsed = SubmissionPayload.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 502, error: 'The Catalog returned an unexpected submission payload.' };
  const projectId = parsed.data.projectId ?? '';
  const project = projectId ? await fetchProject(projectId) : null;
  return { ok: true, submission: raw as Record<string, unknown>, project: project?.ok ? project.project : null, projectId };
}

/** `PUT /project-submissions/{id}/save` — values are already export-shaped. */
export async function saveSubmissionValues(id: string, projectId: string, submission: Record<string, unknown>): Promise<{ ok: true } | CatalogError> {
  const response = await request(`/project-submissions/${encodeURIComponent(id)}/save`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, submission }),
  });
  if (isError(response)) return response;
  if (response.ok) return { ok: true };
  if (response.status === 400 || response.status === 422) {
    const detail = (await response.text().catch(() => '')).trim();
    return { ok: false, status: 400, error: detail ? `The Catalog rejected it: ${detail.slice(0, 300)}` : 'The Catalog rejected those values.' };
  }
  return refusal(response, 'submission');
}

/** `POST /project-submissions/{id}/make-transition` — the Catalog judges legality. */
export async function transitionSubmission(id: string, projectId: string, destinationStatusId: string, note?: string): Promise<{ ok: true } | CatalogError> {
  const response = await request(`/project-submissions/${encodeURIComponent(id)}/make-transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, destinationSubmissionStatusId: destinationStatusId, ...(note ? { note } : {}) }),
  });
  if (isError(response)) return response;
  if (response.ok) return { ok: true };
  if ([400, 409, 422].includes(response.status)) {
    const detail = (await response.text().catch(() => '')).trim();
    return { ok: false, status: 400, error: detail ? `The Catalog would not make that move: ${detail.slice(0, 300)}` : 'The Catalog would not make that move.' };
  }
  return refusal(response, 'submission');
}

const UploadUrl = z.object({ url: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() })).optional() });

export interface UploadTarget {
  url: string;
  headers: { key: string; value: string }[];
  fileId: string;
}

/** Presigned S3 PUT for a new Catalog attachment. Bytes never pass through this server. */
export async function submissionUploadTarget(id: string, extension: string, fileName: string): Promise<{ ok: true; target: UploadTarget } | CatalogError> {
  const suffix = extension.trim().replace(/^\.+/, '');
  if (!suffix) return { ok: false, status: 400, error: 'That file has no extension, so it cannot be uploaded.' };
  const named = catalogUploadFilename(fileName, suffix);
  if (!named.ok) return { ok: false, status: 400, error: named.error };
  const query = new URLSearchParams({ fileExtension: suffix });
  if (named.fileName) query.set('fileName', named.fileName);
  const response = await request(`/project-submissions/${encodeURIComponent(id)}/files/upload-url?${query}`);
  if (isError(response)) return response;
  if (!response.ok) return refusal(response, 'submission');
  const parsed = UploadUrl.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !parsed.data.url.trim()) return { ok: false, status: 502, error: 'The Catalog returned no upload address.' };
  const headers = parsed.data.headers ?? [];
  const fileId = headers.find((h) => h.key.toLowerCase() === 'x-amz-meta-attribute-file-id')?.value.trim() ?? '';
  return { ok: true, target: { url: parsed.data.url, headers, fileId } };
}

function fileMeta(response: Response): { size: number; etag: string | null; mime: string } {
  const range = response.headers.get('content-range');
  const ranged = range?.match(/\/(\d+)\s*$/)?.[1];
  const size = Number(ranged ?? response.headers.get('content-length') ?? '0');
  return {
    size: Number.isFinite(size) ? size : 0,
    etag: response.headers.get('etag'),
    mime: (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '',
  };
}

/**
 * Cheap identity probe. HEAD first; if the signed URL is GET-only, a 1-byte
 * range read still returns size/etag without pulling the object.
 */
export async function probeCatalogFile(url: string): Promise<{ size: number; etag: string | null; mime: string } | null> {
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (head.ok) return fileMeta(head);
  } catch {
    /* signed URLs are often GET-only */
  }
  try {
    const probe = await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000) });
    if (probe.ok || probe.status === 206) {
      await probe.body?.cancel().catch(() => undefined);
      return fileMeta(probe);
    }
  } catch {
    /* fall through to a full download */
  }
  return null;
}

/** Download a Catalog-hosted file (presigned S3). Bounded, server-side. */
export async function downloadCatalogFile(url: string, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array; mime: string } | CatalogError> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15 * 60_000) });
  } catch {
    return { ok: false, status: 502, error: 'Could not download the file from the Catalog.' };
  }
  if (!response.ok) return { ok: false, status: 502, error: `The Catalog file download answered ${response.status}.` };
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) return { ok: false, status: 413, error: `That file is larger than the ${Math.round(maxBytes / 1_048_576)} MB grading limit.` };
  const buffer = await readBoundedBody(response, maxBytes);
  if (!buffer.ok) return buffer;
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  return { ok: true, bytes: buffer.bytes, mime };
}

/** One allocation, abort as soon as the stream exceeds the grading cap. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | CatalogError> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { ok: false, status: 413, error: `That file is larger than the ${Math.round(maxBytes / 1_048_576)} MB grading limit.` };
    return { ok: true, bytes: buffer };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, error: `That file is larger than the ${Math.round(maxBytes / 1_048_576)} MB grading limit.` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
