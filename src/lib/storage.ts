import 'server-only';

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env, storageDriver } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Private object storage. Paths are server-chosen; clients never see them.
 *
 *   s3        private S3 bucket (task role or AWS keys)
 *   gcs       private GCS bucket via Application Default Credentials
 *   supabase  private bucket via the service role
 *   local     files under STORAGE_LOCAL_DIR, served by /api/local-storage
 *             with an HMAC-signed, time-limited URL (development)
 */

/* ───────────────────────────────────────────── local driver ── */

// The root is operator-configured. Composed without path.join/resolve on
// purpose: Turbopack treats those on dynamic input as filesystem access and
// would trace the whole project into the server bundle.
function localRoot(): string {
  const dir = env().STORAGE_LOCAL_DIR;
  return path.isAbsolute(dir) ? dir : `${process.cwd()}${path.sep}${dir}`;
}

function localFile(objectPath: string): string {
  const safe = objectPath.split('/').filter((part) => part && part !== '.' && part !== '..');
  if (safe.length === 0) throw new Error('Invalid storage path.');
  return `${localRoot()}${path.sep}${safe.join(path.sep)}`;
}

function localSignature(objectPath: string, expires: number, method: 'GET' | 'PUT' = 'GET'): string {
  return createHmac('sha256', env().AUTH_LOCAL_SECRET).update(`${method}\n${objectPath}\n${expires}`).digest('hex');
}

/** Validates a URL produced by `signedUrl` in local mode and returns the bytes. */
export async function readLocalSigned(objectPath: string, expires: string, signature: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (storageDriver() !== 'local') return null;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const expected = Buffer.from(localSignature(objectPath, exp, 'GET'), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const bytes = await getObject(objectPath);
  if (!bytes) return null;
  const mime = await readFile(`${localFile(objectPath)}.mime`, 'utf8').catch(() => 'application/octet-stream');
  return { bytes, mime };
}

/** Streams a PUT from a local signed URL onto disk. Does not buffer the body. */
export async function writeLocalSigned(
  objectPath: string,
  expires: string,
  signature: string,
  body: ReadableStream<Uint8Array> | null,
  mime: string,
): Promise<boolean> {
  if (storageDriver() !== 'local' || !body) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(localSignature(objectPath, exp, 'PUT'), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const file = localFile(objectPath);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), createWriteStream(file));
    await writeFile(`${file}.mime`, mime, 'utf8');
    return true;
  } catch {
    await rm(file, { force: true }).catch(() => undefined);
    await rm(`${file}.mime`, { force: true }).catch(() => undefined);
    return false;
  }
}

/* ──────────────────────────────────────────────── s3 driver ── */

let s3: S3Client | null = null;

function s3Client(): S3Client {
  if (s3) return s3;
  const region = env().AWS_REGION;
  if (!region) throw new Error('AWS_REGION is required when STORAGE_DRIVER=s3.');
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  s3 = new S3Client({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  return s3;
}

function s3Bucket(): string {
  return env().STORAGE_BUCKET;
}

function isS3Missing(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  const status =
    error && typeof error === 'object' && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

/* ─────────────────────────────────────────── supabase driver ── */

let bucketChecked = false;

/** Creates the private bucket on first use when it does not exist yet. */
async function ensureBucket(): Promise<void> {
  if (bucketChecked) return;
  const admin = supabaseAdmin();
  const name = env().STORAGE_BUCKET;
  const { data } = await admin.storage.getBucket(name);
  if (!data) {
    const { error } = await admin.storage.createBucket(name, { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(`Storage bucket "${name}" is missing and could not be created: ${error.message}`);
  }
  bucketChecked = true;
}

/* ─────────────────────────────────────────────────── API ── */

export async function putObject(objectPath: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (storageDriver() === 'local') {
    const file = localFile(objectPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(`${file}.mime`, mime, 'utf8');
    return;
  }
  if (storageDriver() === 's3') {
    await s3Client().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: objectPath, Body: Buffer.from(bytes), ContentType: mime }));
    return;
  }
  if (storageDriver() === 'gcs') {
    await (await gcsFile(objectPath)).save(Buffer.from(bytes), { contentType: mime, resumable: false });
    return;
  }
  await ensureBucket();
  const { error } = await supabaseAdmin()
    .storage.from(env().STORAGE_BUCKET)
    .upload(objectPath, Buffer.from(bytes), { contentType: mime, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

export async function getObject(objectPath: string): Promise<Uint8Array | null> {
  if (storageDriver() === 'local') {
    const data = await readFile(localFile(objectPath)).catch(() => null);
    return data ? new Uint8Array(data) : null;
  }
  if (storageDriver() === 's3') {
    try {
      const res = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: objectPath }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? new Uint8Array(bytes) : null;
    } catch (error) {
      if (isS3Missing(error)) return null;
      throw error;
    }
  }
  if (storageDriver() === 'gcs') {
    const [bytes] = await (await gcsFile(objectPath)).download().catch(() => [null]);
    return bytes ? new Uint8Array(bytes) : null;
  }
  const { data, error } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET).download(objectPath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeObject(objectPath: string): Promise<void> {
  if (storageDriver() === 'local') {
    const file = localFile(objectPath);
    await rm(file, { force: true });
    await rm(`${file}.mime`, { force: true });
    return;
  }
  if (storageDriver() === 's3') {
    try {
      await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: objectPath }));
    } catch (error) {
      if (!isS3Missing(error)) throw error;
    }
    return;
  }
  if (storageDriver() === 'gcs') {
    await (await gcsFile(objectPath)).delete({ ignoreNotFound: true });
    return;
  }
  await supabaseAdmin().storage.from(env().STORAGE_BUCKET).remove([objectPath]);
}

/** Short-lived URL for a browser download. */
export async function signedUrl(objectPath: string, seconds = 300): Promise<string | null> {
  if (storageDriver() === 'local') {
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const query = new URLSearchParams({ path: objectPath, expires: String(expires), sig: localSignature(objectPath, expires, 'GET') });
    return `/api/local-storage?${query}`;
  }
  if (storageDriver() === 's3') {
    return getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: s3Bucket(), Key: objectPath }), { expiresIn: seconds });
  }
  if (storageDriver() === 'gcs') {
    const [url] = await (await gcsFile(objectPath)).getSignedUrl({ action: 'read', expires: Date.now() + seconds * 1000 });
    return url ?? null;
  }
  const { data } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET).createSignedUrl(objectPath, seconds);
  return data?.signedUrl ?? null;
}

/** Short-lived PUT target. The browser writes bytes here; the app never buffers them. */
export async function signedPutUrl(objectPath: string, mime: string, seconds = 3_600): Promise<{ url: string; headers: Record<string, string> }> {
  if (storageDriver() === 'local') {
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const query = new URLSearchParams({ path: objectPath, expires: String(expires), sig: localSignature(objectPath, expires, 'PUT') });
    return { url: `/api/local-storage?${query}`, headers: { 'Content-Type': mime } };
  }
  if (storageDriver() === 's3') {
    const url = await getSignedUrl(
      s3Client(),
      new PutObjectCommand({ Bucket: s3Bucket(), Key: objectPath, ContentType: mime }),
      { expiresIn: seconds },
    );
    return { url, headers: { 'Content-Type': mime } };
  }
  if (storageDriver() === 'gcs') {
    const [url] = await (await gcsFile(objectPath)).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + seconds * 1000,
      contentType: mime,
    });
    if (!url) throw new Error('Could not create an upload URL.');
    return { url, headers: { 'Content-Type': mime } };
  }
  await ensureBucket();
  const { data, error } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET).createSignedUploadUrl(objectPath);
  if (error || !data?.signedUrl) throw new Error(`Could not create an upload URL: ${error?.message ?? 'unknown'}`);
  return { url: data.signedUrl, headers: { 'Content-Type': mime } };
}

export async function objectStat(objectPath: string): Promise<{ size: number } | null> {
  if (storageDriver() === 'local') {
    const info = await stat(localFile(objectPath)).catch(() => null);
    return info?.isFile() ? { size: info.size } : null;
  }
  if (storageDriver() === 's3') {
    try {
      const res = await s3Client().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: objectPath }));
      const size = Number(res.ContentLength ?? NaN);
      return Number.isFinite(size) ? { size } : null;
    } catch (error) {
      if (isS3Missing(error)) return null;
      throw error;
    }
  }
  if (storageDriver() === 'gcs') {
    const [meta] = await (await gcsFile(objectPath)).getMetadata().catch(() => [null]);
    const size = Number(meta?.size ?? NaN);
    return Number.isFinite(size) ? { size } : null;
  }
  const slash = objectPath.lastIndexOf('/');
  const prefix = slash >= 0 ? objectPath.slice(0, slash) : '';
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath;
  const { data } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET).list(prefix, { search: name, limit: 20 });
  const hit = data?.find((row) => row.name === name);
  const raw = hit?.metadata && typeof hit.metadata === 'object' && 'size' in hit.metadata ? hit.metadata.size : undefined;
  const size = Number(raw ?? NaN);
  return hit && Number.isFinite(size) ? { size } : null;
}

/** SHA-256 of the stored object, streamed. */
export async function hashObject(objectPath: string): Promise<string | null> {
  if (storageDriver() === 'local') {
    const file = localFile(objectPath);
    if (!(await stat(file).catch(() => null))) return null;
    return hashStream(createReadStream(file));
  }
  if (storageDriver() === 's3') {
    try {
      const res = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: objectPath }));
      if (!res.Body) return null;
      return hashStream(res.Body as NodeJS.ReadableStream);
    } catch (error) {
      if (isS3Missing(error)) return null;
      throw error;
    }
  }
  if (storageDriver() === 'gcs') {
    return hashStream((await gcsFile(objectPath)).createReadStream());
  }
  const bytes = await getObject(objectPath);
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}

function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function gcsFile(objectPath: string) {
  const { Storage } = await import('@google-cloud/storage');
  return new Storage().bucket(env().STORAGE_BUCKET).file(objectPath);
}
