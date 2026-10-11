import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiOutputFiles } from '@/db/schema';
import { downloadCatalogFile, fetchSubmission } from '@/lib/catalog/client';
import { readCatalogSubmission } from '@/lib/catalog/read';
import { documentViewKind } from '@/lib/ai/documentView';
import { errorResponse } from '@/lib/api';
import {
  browserCanShow,
  catalogUrlStale,
  documentViewResponse,
  downloadPath,
  previewFallbackPage,
  proxyFile,
  wantsStandaloneView,
  wantsThumb,
} from '@/lib/services/preview';
import { notFound, ServiceError } from '@/lib/services/errors';
import { assertShareToken } from '@/lib/services/share';
import { getSubmission, readSource } from '@/lib/services/submissions';
import { getObject, signedUrl } from '@/lib/storage';

/** Token-gated file stream for the public View task page. */
export async function GET(request: Request, context: { params: Promise<{ id: string; fileId: string }> }): Promise<Response> {
  try {
    const { id, fileId } = await context.params;
    assertShareToken(id, new URL(request.url).searchParams.get('t'));
    const database = db();
    const submission = await getSubmission(database, id);
    const catalog = await resolveCatalogFile(submission, fileId);
    if (catalog) return sendCatalogFile(catalog, request);
    return sendAiFile(id, fileId, request);
  } catch (error) {
    return errorResponse(error);
  }
}

async function resolveCatalogFile(submission: Awaited<ReturnType<typeof getSubmission>>, fileId: string) {
  const stored = readSource(submission)?.files.find((f) => f.id === fileId);
  const fresh = await fetchSubmission(submission.catalogSubmissionId);
  if (fresh.ok) {
    const read = readCatalogSubmission(fresh.submission, fresh.project);
    return read?.files.find((f) => f.id === fileId) ?? stored ?? null;
  }
  return stored ?? null;
}

async function sendCatalogFile(file: { id: string; name: string; mime: string; downloadUrl: string | null; previewUrl: string | null; thumbnailUrl: string | null }, request: Request): Promise<Response> {
  const mime = file.mime || 'application/octet-stream';
  const fallback = { downloadHref: downloadPath(request) };
  if (wantsThumb(request)) {
    if (file.thumbnailUrl && !catalogUrlStale(file.thumbnailUrl)) return proxyFile(file.thumbnailUrl, request, 'image/jpeg', file.name);
    if (mime.startsWith('image/') && file.downloadUrl) return proxyFile(file.downloadUrl, request, mime, file.name);
    return new Response(null, { status: 404 });
  }
  if (wantsStandaloneView(request)) {
    if (file.downloadUrl && documentViewKind(file.name, mime)) {
      const downloaded = await downloadCatalogFile(file.downloadUrl, 80 * 1024 * 1024);
      if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, downloaded.error);
      return documentViewResponse(downloaded.bytes, file.name, downloaded.mime || mime, fallback.downloadHref);
    }
    if (file.previewUrl) return proxyFile(file.previewUrl, request, mime, file.name);
    if (file.downloadUrl && browserCanShow(mime, file.name)) return proxyFile(file.downloadUrl, request, mime, file.name);
    if (file.downloadUrl) {
      const downloaded = await downloadCatalogFile(file.downloadUrl, 80 * 1024 * 1024);
      if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, downloaded.error);
      return documentViewResponse(downloaded.bytes, file.name, downloaded.mime || mime, fallback.downloadHref);
    }
    return previewFallbackPage(file.name, fallback.downloadHref, 'The Catalog has no download address for this file.');
  }
  if (!file.downloadUrl) throw notFound('A download address for the file');
  return proxyFile(file.downloadUrl, request, mime, file.name);
}

async function sendAiFile(submissionId: string, fileId: string, request: Request): Promise<Response> {
  const row = (
    await db()
      .select()
      .from(aiOutputFiles)
      .where(and(eq(aiOutputFiles.id, fileId), eq(aiOutputFiles.submissionId, submissionId), isNull(aiOutputFiles.removedAt)))
      .limit(1)
  )[0];
  if (!row) throw notFound('The file');
  const fallback = { downloadHref: downloadPath(request) };
  if (wantsThumb(request)) {
    if (row.mime.startsWith('image/')) {
      const url = await signedUrl(row.storagePath, 300);
      if (!url) throw notFound('The file');
      return proxyFile(new URL(url, request.url).toString(), request, row.mime, row.name);
    }
    return new Response(null, { status: 404 });
  }
  if (wantsStandaloneView(request)) {
    if (documentViewKind(row.name, row.mime)) {
      const bytes = await getObject(row.storagePath);
      if (!bytes) throw notFound('The file');
      return documentViewResponse(bytes, row.name, row.mime, fallback.downloadHref);
    }
    if (browserCanShow(row.mime, row.name)) {
      const url = await signedUrl(row.storagePath, 300);
      if (!url) throw notFound('The file');
      return proxyFile(new URL(url, request.url).toString(), request, row.mime, row.name);
    }
    const bytes = await getObject(row.storagePath);
    if (!bytes) throw notFound('The file');
    return documentViewResponse(bytes, row.name, row.mime, fallback.downloadHref);
  }
  const url = await signedUrl(row.storagePath, 300);
  if (!url) throw notFound('The file');
  return proxyFile(new URL(url, request.url).toString(), request, row.mime, row.name);
}
