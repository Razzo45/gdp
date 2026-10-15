import { db } from '@/db/client';
import { route } from '@/lib/api';
import { downloadCatalogFile } from '@/lib/catalog/client';
import { maySeeGoldenFiles } from '@/lib/auth/permissions';
import { forbidden, notFound, ServiceError } from '@/lib/services/errors';
import { documentViewKind } from '@/lib/ai/documentView';
import {
  browserCanShow,
  catalogFileBytesUrl,
  catalogUrlStale,
  documentViewResponse,
  downloadPath,
  previewFallbackPage,
  proxyFile,
  wantsStandaloneView,
  wantsThumb,
} from '@/lib/services/preview';
import { getVisibleSubmission, readSource, syncSubmission } from '@/lib/services/submissions';

/**
 * Catalog input or Golden file. The browser only talks to us; we refresh the
 * short-lived Catalog URL and stream that object (or its Catalog thumbnail /
 * preview). Office files without a Catalog preview fall back to a PDF render.
 */
export const GET = route({}, async ({ actor, params, request }) => {
  let submission = await getVisibleSubmission(db(), actor, params['id']!);
  let source = readSource(submission);
  let file = source?.files.find((f) => f.id === params['fileId']);
  if (!file) throw notFound('The file');
  const current = file;
  const golden = source?.goldenFiles.some((f) => f.id === current.id);
  if (golden && !maySeeGoldenFiles(actor, submission)) throw forbidden('Golden files are not part of the review view.');

  const catalogId = submission.catalogSubmissionId;
  const urlsNeedRefresh =
    catalogUrlStale(file.downloadUrl, catalogId) ||
    (file.previewUrl ? catalogUrlStale(file.previewUrl, catalogId) : false) ||
    (file.thumbnailUrl ? catalogUrlStale(file.thumbnailUrl, catalogId) : false);
  if (urlsNeedRefresh) {
    submission = await syncSubmission(catalogId, actor.id);
    source = readSource(submission);
    file = source?.files.find((f) => f.id === params['fileId']);
  }
  if (!file) throw notFound('The file');

  const mime = file.mime || 'application/octet-stream';
  const fallback = { downloadHref: downloadPath(request) };
  const bytesUrl = catalogFileBytesUrl(file, catalogId);

  if (wantsThumb(request)) {
    if (file.thumbnailUrl) return proxyFile(file.thumbnailUrl, request, 'image/jpeg', file.name);
    if (mime.startsWith('image/') && bytesUrl) return proxyFile(bytesUrl, request, mime, file.name);
    return new Response(null, { status: 404 });
  }

  if (wantsStandaloneView(request)) {
    if (bytesUrl && documentViewKind(file.name, mime)) {
      const downloaded = await downloadCatalogFile(bytesUrl, 80 * 1024 * 1024);
      if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, downloaded.error);
      return documentViewResponse(downloaded.bytes, file.name, downloaded.mime || mime, fallback.downloadHref);
    }
    if (file.previewUrl) return proxyFile(file.previewUrl, request, mime, file.name);
    if (bytesUrl && browserCanShow(mime, file.name)) return proxyFile(bytesUrl, request, mime, file.name);
    if (bytesUrl) {
      const downloaded = await downloadCatalogFile(bytesUrl, 80 * 1024 * 1024);
      if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, downloaded.error);
      return documentViewResponse(downloaded.bytes, file.name, downloaded.mime || mime, fallback.downloadHref);
    }
    return previewFallbackPage(file.name, fallback.downloadHref, 'The Catalog has no download address for this file.');
  }

  if (!bytesUrl) throw notFound('A download address for the file');
  return proxyFile(bytesUrl, request, mime, file.name);
});
