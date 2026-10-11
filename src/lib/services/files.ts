import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiOutputFiles, catalogFileCache, submissions, type AiOutputFile, type Submission } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { sha256 } from '@/domain/fingerprint';
import { canReuseStagedUri, catalogIdentityMatch } from '@/domain/jobs';
import { holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import { downloadCatalogFile, probeCatalogFile } from '@/lib/catalog/client';
import type { CatalogFile } from '@/lib/catalog/types';
import { lookupActiveFileUri, rememberGeminiUse } from '@/lib/ai/gemini';
import { MAX_FILE_BYTES, normaliseMime, prepareFile, preparedFromUri, type PreparedFile, type SourceFile } from '@/lib/ai/media';
import { env } from '@/lib/env';
import { getObject, hashObject, objectStat, putObject, removeObject, signedPutUrl } from '@/lib/storage';
import { conflict, forbidden, invalid, notFound, ServiceError } from './errors';
import { getSubmission, readSource, recordEvent, syncSubmission } from './submissions';

/**
 * Where bytes come from:
 *  - Golden output and task inputs live on the Catalog's S3 behind presigned
 *    URLs that expire (~50 min). We re-sync the submission to refresh them
 *    and read the bytes when a job needs them. Nothing is copied.
 *  - AI outputs are the same kinds of files (including multi-GB video). The
 *    browser PUTs them to a signed URL on our private bucket; the app stores
 *    only the object path and hash. Same pattern as Catalog, different bucket.
 */

const MAX_AI_OUTPUT_BYTES = MAX_FILE_BYTES;
const MAX_AI_OUTPUTS = 12;

async function catalogList(submission: Submission, kind: 'golden' | 'inputs'): Promise<{ submission: Submission; list: CatalogFile[] }> {
  let source = readSource(submission);
  if (!source) throw new ServiceError(502, 'The stored Catalog payload could not be read.');
  let list = kind === 'golden' ? source.goldenFiles : source.inputFiles;
  const stale = list.some((f) => !f.downloadUrl || urlExpired(f.downloadUrl));
  if (stale) {
    const fresh = await syncSubmission(submission.catalogSubmissionId, null);
    source = readSource(fresh);
    if (!source) throw new ServiceError(502, 'The refreshed Catalog payload could not be read.');
    list = kind === 'golden' ? source.goldenFiles : source.inputFiles;
    return { submission: fresh, list };
  }
  return { submission, list };
}

async function rememberCatalogIdentity(file: CatalogFile, size: number, etag: string | null, digest: string, mime: string): Promise<void> {
  await db()
    .insert(catalogFileCache)
    .values({ fileId: file.id, name: file.name, mime, size, etag, sha256: digest, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: catalogFileCache.fileId,
      set: { name: file.name, mime, size, etag, sha256: digest, updatedAt: new Date().toISOString() },
    });
}


/** Prepare Catalog files for grading. Reuses a live Gemini handle when the object has not changed. */
export async function prepareCatalogFiles(submission: Submission, kind: 'golden' | 'inputs', role: string, onlyIds?: readonly string[]): Promise<{ files: PreparedFile[]; fingerprint: string }> {
  const resolved = await catalogList(submission, kind);
  const wanted = onlyIds?.length ? resolved.list.filter((f) => onlyIds.includes(f.id) || onlyIds.includes(f.name)) : resolved.list;
  const files: PreparedFile[] = [];
  for (const file of wanted) {
    const prepared = await prepareOneCatalog(file, role, resolved.submission.catalogSubmissionId);
    await rememberGeminiUse(prepared.sha256, resolved.submission.id);
    files.push(prepared);
  }
  return { files, fingerprint: sha256(files.map((f) => `${f.id}:${f.sha256}`).join('|')) };
}

const catalogPrepareInFlight = new Map<string, Promise<PreparedFile>>();

async function prepareOneCatalog(file: CatalogFile, role: string, submissionId: string): Promise<PreparedFile> {
  const key = `${submissionId}:${file.id}:${role}`;
  const pending = catalogPrepareInFlight.get(key);
  if (pending) return pending;
  const work = prepareOneCatalogOnce(file, role, submissionId);
  catalogPrepareInFlight.set(key, work);
  try {
    return await work;
  } finally {
    if (catalogPrepareInFlight.get(key) === work) catalogPrepareInFlight.delete(key);
  }
}

async function prepareOneCatalogOnce(file: CatalogFile, role: string, catalogSubmissionId?: string): Promise<PreparedFile> {
  if ((!file.downloadUrl || urlExpired(file.downloadUrl)) && catalogSubmissionId) {
    const fresh = readSource(await syncSubmission(catalogSubmissionId, null));
    file = fresh?.files.find((item) => item.id === file.id) ?? file;
  }
  if (!file.downloadUrl) throw new ServiceError(502, `The Catalog gave no download address for ${file.name}.`);
  const cached = (await db().select().from(catalogFileCache).where(eq(catalogFileCache.fileId, file.id)).limit(1))[0];
  const probe = await probeCatalogFile(file.downloadUrl);
  if (cached && (!probe || catalogIdentityMatch(cached, probe))) {
    const uri = await lookupActiveFileUri(cached.sha256);
    if (uri && canReuseStagedUri(cached.mime, file.name)) {
      return preparedFromUri({ id: file.id, name: file.name, mime: cached.mime, sha256: cached.sha256, size: cached.size, uri, role });
    }
  }
  let downloaded = await downloadCatalogFile(file.downloadUrl, MAX_FILE_BYTES);
  if (!downloaded.ok && catalogSubmissionId) {
    const fresh = readSource(await syncSubmission(catalogSubmissionId, null));
    file = fresh?.files.find((item) => item.id === file.id) ?? file;
    if (!file.downloadUrl) throw new ServiceError(502, `The Catalog gave no download address for ${file.name}.`);
    downloaded = await downloadCatalogFile(file.downloadUrl, MAX_FILE_BYTES);
  }
  if (!downloaded.ok) throw new ServiceError(downloaded.status === 413 ? 422 : 502, `${file.name}: ${downloaded.error}`);
  const mime = normaliseMime(file.name, downloaded.mime || file.mime);
  const digest = sha256(downloaded.bytes);
  await rememberCatalogIdentity(file, downloaded.bytes.byteLength, probe?.etag ?? null, digest, mime);
  return prepareFile({ id: file.id, name: file.name, mime, bytes: downloaded.bytes }, role);
}

export async function catalogSourceFiles(submission: Submission, kind: 'golden' | 'inputs'): Promise<{ files: SourceFile[]; fingerprint: string }> {
  const resolved = await catalogList(submission, kind);
  const files: SourceFile[] = [];
  for (const file of resolved.list) {
    if (!file.downloadUrl) throw new ServiceError(502, `The Catalog gave no download address for ${file.name}.`);
    const downloaded = await downloadCatalogFile(file.downloadUrl, MAX_FILE_BYTES);
    if (!downloaded.ok) throw new ServiceError(502, `${file.name}: ${downloaded.error}`);
    const mime = normaliseMime(file.name, downloaded.mime || file.mime);
    const digest = sha256(downloaded.bytes);
    await rememberCatalogIdentity(file, downloaded.bytes.byteLength, null, digest, mime);
    files.push({ id: file.id, name: file.name, mime, bytes: downloaded.bytes });
  }
  return { files, fingerprint: sha256(files.map((f) => `${f.id}:${sha256(f.bytes)}`).join('|')) };
}

export async function prepareAiOutputs(database: DbOrTx, submissionId: string, role: string): Promise<{ files: PreparedFile[]; fingerprint: string }> {
  const rows = await listAiOutputs(database, submissionId);
  const files: PreparedFile[] = [];
  for (const row of rows) {
    const uri = await lookupActiveFileUri(row.sha256);
    if (uri && canReuseStagedUri(row.mime, row.name)) {
      await rememberGeminiUse(row.sha256, submissionId);
      files.push(preparedFromUri({ id: row.id, name: row.name, mime: row.mime, sha256: row.sha256, size: row.size, uri, role }));
      continue;
    }
    const bytes = await getObject(row.storagePath);
    if (!bytes) throw new ServiceError(502, `${row.name} is missing from storage.`);
    const prepared = await prepareFile({ id: row.id, name: row.name, mime: row.mime, bytes }, role);
    await rememberGeminiUse(prepared.sha256, submissionId);
    files.push(prepared);
  }
  return { files, fingerprint: sha256(files.map((f) => `${f.id}:${f.sha256}`).join('|')) };
}

function urlExpired(url: string): boolean {
  try {
    const u = new URL(url);
    const date = u.searchParams.get('X-Amz-Date');
    const expires = u.searchParams.get('X-Amz-Expires');
    if (!date || !expires) return false;
    const issued = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    return Number.isFinite(issued) && issued + Number(expires) * 1000 - 120_000 < Date.now();
  } catch {
    return false;
  }
}

export function describeCatalogFiles(files: CatalogFile[]): string {
  return files.map((f) => `${f.name} (id ${f.id})`).join(', ') || '(none)';
}

/* ─────────────────────────────────────────── AI outputs ── */

export async function listAiOutputs(database: DbOrTx, submissionId: string): Promise<AiOutputFile[]> {
  return database.select().from(aiOutputFiles).where(and(eq(aiOutputFiles.submissionId, submissionId), isNull(aiOutputFiles.removedAt))).orderBy(aiOutputFiles.createdAt);
}

export async function aiOutputSourceFiles(database: DbOrTx, submissionId: string): Promise<{ files: SourceFile[]; fingerprint: string }> {
  const rows = await listAiOutputs(database, submissionId);
  const files: SourceFile[] = [];
  for (const row of rows) {
    const bytes = await getObject(row.storagePath);
    if (!bytes) throw new ServiceError(502, `${row.name} is missing from storage.`);
    if (sha256(bytes) !== row.sha256) throw new ServiceError(502, `${row.name} in storage does not match its recorded hash.`);
    files.push({ id: row.id, name: row.name, mime: row.mime, bytes });
  }
  return { files, fingerprint: sha256(rows.map((r) => `${r.id}:${r.sha256}`).join('|')) };
}

export async function addAiOutput(actor: Actor, submissionId: string, upload: { name: string; mime: string; bytes: Uint8Array }): Promise<AiOutputFile> {
  const name = cleanName(upload.name);
  if (!name) throw invalid('The file needs a name.');
  if (upload.bytes.byteLength === 0) throw invalid('The file is empty.');
  if (upload.bytes.byteLength > MAX_AI_OUTPUT_BYTES) throw invalid(`Files above ${Math.round(MAX_AI_OUTPUT_BYTES / 1_048_576)} MB cannot be graded.`);

  const { database } = await assertAiOutputMutable(actor, submissionId);
  const digest = sha256(upload.bytes);
  const mime = normaliseMime(name, upload.mime);
  const path = `ai-outputs/${submissionId}/${crypto.randomUUID()}-${name}`;
  await putObject(path, upload.bytes, mime);
  return insertAiOutput(database, actor, submissionId, { name, mime, size: upload.bytes.byteLength, sha256: digest, storagePath: path });
}

const UPLOAD_TTL_SEC = 60 * 60;

export interface AiOutputUploadTicket {
  path: string;
  uploadUrl: string;
  headers: Record<string, string>;
  token: string;
  expires: number;
}

/** Issues a signed PUT so the browser writes the file to object storage. */
export async function beginAiOutput(actor: Actor, submissionId: string, upload: { name: string; mime: string; size: number }): Promise<AiOutputUploadTicket> {
  const name = cleanName(upload.name);
  if (!name) throw invalid('The file needs a name.');
  if (!Number.isFinite(upload.size) || upload.size <= 0) throw invalid('The file is empty.');
  if (upload.size > MAX_AI_OUTPUT_BYTES) throw invalid(`Files above ${Math.round(MAX_AI_OUTPUT_BYTES / 1_048_576)} MB cannot be graded.`);
  await assertAiOutputMutable(actor, submissionId);
  const mime = normaliseMime(name, upload.mime);
  const path = `ai-outputs/${submissionId}/${crypto.randomUUID()}-${name}`;
  const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SEC;
  const put = await signedPutUrl(path, mime, UPLOAD_TTL_SEC);
  return { path, uploadUrl: put.url, headers: put.headers, token: uploadTicket(path, name, mime, upload.size, expires), expires };
}

/** Records the object after the browser PUT. Hashes on the server, streamed. */
export async function finishAiOutput(
  actor: Actor,
  submissionId: string,
  ticket: { path: string; name: string; mime: string; size: number; token: string; expires: number },
): Promise<AiOutputFile> {
  const name = cleanName(ticket.name);
  if (!name) throw invalid('The file needs a name.');
  const mime = normaliseMime(name, ticket.mime);
  if (!ticket.path.startsWith(`ai-outputs/${submissionId}/`)) throw invalid('That upload ticket is not for this task.');
  verifyUploadTicket(ticket.path, name, mime, ticket.size, ticket.expires, ticket.token);
  const { database } = await assertAiOutputMutable(actor, submissionId);
  const found = await objectStat(ticket.path);
  if (!found) throw new ServiceError(502, 'The file never landed in storage. Try the upload again.');
  if (found.size !== ticket.size) throw invalid(`The stored file is ${found.size} bytes, not the ${ticket.size} that were promised.`);
  const digest = await hashObject(ticket.path);
  if (!digest) throw new ServiceError(502, 'The file never landed in storage. Try the upload again.');
  return insertAiOutput(database, actor, submissionId, { name, mime, size: found.size, sha256: digest, storagePath: ticket.path });
}

export async function removeAiOutput(actor: Actor, submissionId: string, fileId: string): Promise<void> {
  const database = db();
  const submission = await getSubmission(database, submissionId);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  if (submission.stage !== 'rubric') throw conflict('AI output files can only change while the task is in the rubric stage.');
  const row = (await database.select().from(aiOutputFiles).where(and(eq(aiOutputFiles.id, fileId), eq(aiOutputFiles.submissionId, submissionId), isNull(aiOutputFiles.removedAt))).limit(1))[0];
  if (!row) throw notFound('The AI output file');
  await database.update(aiOutputFiles).set({ removedAt: new Date().toISOString() }).where(eq(aiOutputFiles.id, fileId));
  await removeObject(row.storagePath).catch(() => undefined);
  await recordEvent(database, submissionId, actor.id, 'ai_output_removed', { fileId, name: row.name });
}

function cleanName(raw: string): string {
  return raw.replace(/[\\/]/g, '_').trim().slice(0, 200);
}

async function assertAiOutputMutable(actor: Actor, submissionId: string) {
  const database = db();
  const submission = await getSubmission(database, submissionId);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  if (submission.stage !== 'rubric') throw conflict('AI output files can only change while the task is in the rubric stage; the reviewer and stability must see the same files.');
  const existing = await listAiOutputs(database, submissionId);
  if (existing.length >= MAX_AI_OUTPUTS) throw invalid(`At most ${MAX_AI_OUTPUTS} AI output files per task.`);
  return { database, submission };
}

async function insertAiOutput(
  database: DbOrTx,
  actor: Actor,
  submissionId: string,
  values: { name: string; mime: string; size: number; sha256: string; storagePath: string },
): Promise<AiOutputFile> {
  const [row] = await database.insert(aiOutputFiles).values({ submissionId, uploadedBy: actor.id, ...values }).returning();
  await recordEvent(database, submissionId, actor.id, 'ai_output_added', { fileId: row!.id, name: values.name, size: values.size });
  return row!;
}

function uploadTicket(path: string, name: string, mime: string, size: number, expires: number): string {
  return createHmac('sha256', env().AUTH_LOCAL_SECRET).update(`ai-put\n${path}\n${name}\n${mime}\n${size}\n${expires}`).digest('hex');
}

function verifyUploadTicket(path: string, name: string, mime: string, size: number, expires: number, token: string): void {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) throw invalid('That upload ticket has expired. Start the upload again.');
  const expected = Buffer.from(uploadTicket(path, name, mime, size, expires), 'hex');
  const given = Buffer.from(token, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid('That upload ticket is invalid or has expired.');
}

export async function touchSubmission(database: DbOrTx, submissionId: string): Promise<void> {
  await database.update(submissions).set({ updatedAt: new Date().toISOString() }).where(eq(submissions.id, submissionId));
}
