import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HeadObjectCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

/**
 * Streams AI output bytes onto the Railway EU bucket. Never writes Supabase.
 *
 *   npx railway run --service Postgres -- npx tsx scripts/hydrate-ai-outputs.ts --apply
 */

const BUCKET_NAME = 'adaptable-toybox';
const AI_BUCKET = 'submissions';

function parseDotenv(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    map.set(line.slice(0, at).trim(), value);
  }
  return map;
}

function railwayUrl(): string {
  const host = process.env['PGHOST_PUBLIC']?.trim();
  const port = process.env['PGPORT_PUBLIC']?.trim();
  const user = process.env['PGUSER']?.trim();
  const password = process.env['PGPASSWORD'] ?? '';
  const database = process.env['PGDATABASE']?.trim() || 'railway';
  if (!host || !port || !user) throw new Error('Run via `railway run --service Postgres`.');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?sslmode=require`;
}

function bucketClient(): { client: S3Client; bucket: string } {
  const endpoint = process.env['STORAGE_S3_ENDPOINT']?.trim();
  const bucket = process.env['STORAGE_S3_BUCKET']?.trim();
  const accessKeyId = process.env['STORAGE_S3_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = process.env['STORAGE_S3_SECRET_ACCESS_KEY']?.trim();
  const region = process.env['STORAGE_S3_REGION']?.trim() || 'auto';
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return {
      bucket,
      client: new S3Client({
        region,
        endpoint,
        forcePathStyle: false,
        credentials: { accessKeyId, secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
    };
  }
  const result = spawnSync('npx', ['--yes', '@railway/cli', 'bucket', 'credentials', '--bucket', BUCKET_NAME, '--json'], {
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) throw new Error('Could not read Railway bucket credentials.');
  const start = result.stdout.lastIndexOf('{');
  if (start < 0) throw new Error('Railway bucket credentials were empty.');
  const creds = JSON.parse(result.stdout.slice(start)) as {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    region?: string;
  };
  return {
    bucket: creds.bucketName,
    client: new S3Client({
      region: creds.region || 'auto',
      endpoint: creds.endpoint,
      forcePathStyle: false,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

async function remoteSize(client: S3Client, bucket: string, key: string): Promise<number | null> {
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const size = Number(out.ContentLength ?? NaN);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

function localPath(storagePath: string): string {
  return path.join(process.cwd(), 'tmp', 'storage', ...storagePath.split('/'));
}

async function uploadFile(client: S3Client, bucket: string, key: string, file: string, mime: string): Promise<void> {
  await new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: createReadStream(file), ContentType: mime },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
  }).done();
}

async function downloadSupabase(storagePath: string): Promise<Uint8Array | null> {
  const env = parseDotenv(path.join(process.cwd(), '.env.local'));
  const url = env.get('SUPABASE_READ_URL') || env.get('NEXT_PUBLIC_SUPABASE_URL');
  const key = env.get('SUPABASE_READ_SERVICE_ROLE_KEY') || env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.storage.from(AI_BUCKET).download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

function legacySupabaseGuess(storagePath: string): string | null {
  const match = storagePath.match(/\/legacy\/(.+)$/);
  if (!match?.[1]) return null;
  return `wirestock-ai/${match[1]}`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { client, bucket } = bucketClient();
  if (apply) {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedOrigins: ['https://gdp-production-83d5.up.railway.app', 'http://localhost:3000'],
              ExposeHeaders: ['ETag', 'Content-Length'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
    console.log('cors ok');
  }

  const sql = postgres(railwayUrl(), { max: 1, prepare: false, ssl: 'require', connection: { application_name: 'gdp-hydrate-ai' } });
  try {
    const rows = await sql<{ id: string; name: string; mime: string; size: number; storage_path: string }[]>`
      select id, name, mime, size, storage_path
      from app.ai_output_files
      where removed_at is null
      order by name
    `;
    let uploaded = 0;
    let skipped = 0;
    let missing = 0;
    for (const row of rows) {
      const have = await remoteSize(client, bucket, row.storage_path);
      if (have === row.size) {
        console.log(`skip ${row.name} (already ${have})`);
        skipped += 1;
        continue;
      }
      const disk = localPath(row.storage_path);
      if (existsSync(disk)) {
        const size = statSync(disk).size;
        console.log(`${apply ? 'upload' : 'would upload'} ${row.name} ${Math.round(size / 1_048_576)}MB from disk`);
        if (apply) await uploadFile(client, bucket, row.storage_path, disk, row.mime);
        uploaded += 1;
        continue;
      }
      const guess = legacySupabaseGuess(row.storage_path);
      const bytes = guess ? await downloadSupabase(guess) : null;
      if (bytes && bytes.byteLength > 0) {
        console.log(`${apply ? 'upload' : 'would upload'} ${row.name} ${Math.round(bytes.byteLength / 1_048_576)}MB from supabase`);
        if (apply) {
          await new Upload({
            client,
            params: { Bucket: bucket, Key: row.storage_path, Body: Buffer.from(bytes), ContentType: row.mime },
          }).done();
        }
        uploaded += 1;
        continue;
      }
      console.log(`missing ${row.name} ${row.storage_path}`);
      missing += 1;
    }
    console.log(`${apply ? 'uploaded' : 'would upload'} ${uploaded}; skipped ${skipped}; missing ${missing}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
