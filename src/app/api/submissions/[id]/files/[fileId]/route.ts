import { db } from '@/db/client';
import { route } from '@/lib/api';
import { downloadCatalogFile } from '@/lib/catalog/client';
import { maySeeGoldenFiles } from '@/lib/auth/permissions';
import { forbidden, notFound, ServiceError } from '@/lib/services/errors';
import { officePreviewResponse, proxyFile, wantsOfficePreview } from '@/lib/services/preview';
import { getVisibleSubmission, readSource, syncSubmission } from '@/lib/services/submissions';

/**
 * Catalog input or Golden file. The browser only talks to us; we refresh the
 * short-lived Catalog URL and either stream it (so video/PDF work same-origin)
 * or render an Office file to PDF for the on-page viewer.
 */
export const GET = route({}, async ({ actor, params, request }) => {
  let submission = await getVisibleSubmission(db(), actor, params['id']!);
  let source = readSource(submission);
  let file = source?.files.find((f) => f.id === params['fileId']);
  if (!file) throw notFound('The file');
  const golden = source?.goldenFiles.some((f) => f.id === file.id);
  if (golden && !maySeeGoldenFiles(actor, submission)) throw forbidden('Golden files are not part of the review view.');
  if (!file.downloadUrl || isExpired(file.downloadUrl)) {
    submission = await syncSubmission(submission.catalogSubmissionId, actor.id);
    source = readSource(submission);
    file = source?.files.find((f) => f.id === params['fileId']);
  }
  if (!file?.downloadUrl) throw notFound('A download address for the file');
  const mime = file.mime || 'application/octet-stream';
  if (wantsOfficePreview(request, file.name, mime)) {
    const downloaded = await downloadCatalogFile(file.downloadUrl, 80 * 1024 * 1024);
    if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, downloaded.error);
    return officePreviewResponse(downloaded.bytes, file.name, downloaded.mime || mime);
  }
  return proxyFile(file.downloadUrl, request, mime, file.name);
});

function isExpired(url: string): boolean {
  try {
    const u = new URL(url);
    const date = u.searchParams.get('X-Amz-Date');
    const expires = u.searchParams.get('X-Amz-Expires');
    if (!date || !expires) return false;
    const issued = DateParseSafe(date);
    return Number.isFinite(issued) && issued + Number(expires) * 1000 - 60_000 < Date.now();
  } catch {
    return false;
  }
}

function DateParseSafe(date: string): number {
  return Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
}
