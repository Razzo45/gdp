import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiOutputFiles } from '@/db/schema';
import { route } from '@/lib/api';
import { notFound } from '@/lib/services/errors';
import { removeAiOutput } from '@/lib/services/files';
import { officePreviewResponse, proxyFile, wantsOfficePreview } from '@/lib/services/preview';
import { getVisibleSubmission } from '@/lib/services/submissions';
import { getObject, signedUrl } from '@/lib/storage';

export const DELETE = route({}, async ({ actor, params }) => {
  await removeAiOutput(actor, params['id']!, params['fileId']!);
  return { ok: true };
});

/** Same-origin stream (or Office→PDF preview) for an uploaded AI output. */
export const GET = route({}, async ({ actor, params, request }) => {
  const database = db();
  await getVisibleSubmission(database, actor, params['id']!);
  const row = (await database.select().from(aiOutputFiles).where(and(eq(aiOutputFiles.id, params['fileId']!), eq(aiOutputFiles.submissionId, params['id']!), isNull(aiOutputFiles.removedAt))).limit(1))[0];
  if (!row) throw notFound('The file');
  if (wantsOfficePreview(request, row.name, row.mime)) {
    const bytes = await getObject(row.storagePath);
    if (!bytes) throw notFound('The file');
    return officePreviewResponse(bytes, row.name, row.mime);
  }
  const url = await signedUrl(row.storagePath, 300);
  if (!url) throw notFound('The file');
  return proxyFile(new URL(url, request.url).toString(), request, row.mime, row.name);
});
