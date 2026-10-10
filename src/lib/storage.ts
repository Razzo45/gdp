import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, storageDriver } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Private object storage. Paths are server-chosen; clients never see them.
 *
 *   supabase  private bucket via the service role (production)
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

function localSignature(objectPath: string, expires: number): string {
  return createHmac('sha256', env().AUTH_LOCAL_SECRET).update(`${objectPath}\n${expires}`).digest('hex');
}

/** Validates a URL produced by `signedUrl` in local mode and returns the bytes. */
export async function readLocalSigned(objectPath: string, expires: string, signature: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (storageDriver() !== 'local') return null;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const expected = Buffer.from(localSignature(objectPath, exp), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const bytes = await getObject(objectPath);
  if (!bytes) return null;
  const mime = await readFile(`${localFile(objectPath)}.mime`, 'utf8').catch(() => 'application/octet-stream');
  return { bytes, mime };
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
  await supabaseAdmin().storage.from(env().STORAGE_BUCKET).remove([objectPath]);
}

/** Short-lived URL for a browser download. */
export async function signedUrl(objectPath: string, seconds = 300): Promise<string | null> {
  if (storageDriver() === 'local') {
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const query = new URLSearchParams({ path: objectPath, expires: String(expires), sig: localSignature(objectPath, expires) });
    return `/api/local-storage?${query}`;
  }
  const { data } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET).createSignedUrl(objectPath, seconds);
  return data?.signedUrl ?? null;
}
