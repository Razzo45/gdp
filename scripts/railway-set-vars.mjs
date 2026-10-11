import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Sets Railway service vars from .env.local. Never prints values. */
const service = process.argv[2] ?? 'gdp';
const root = process.cwd();
const file = path.join(root, '.env.local');
if (!existsSync(file)) {
  console.error('No .env.local');
  process.exit(1);
}

function parseEnv(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
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

function setVar(key, value) {
  const result = spawnSync('npx', ['--yes', '@railway/cli', 'variable', 'set', key, '--stdin', '--service', service, '--skip-deploys'], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });
  if (result.status !== 0) {
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`;
    const safe = err.replaceAll(value, '[redacted]').trim();
    console.error(`failed ${key}: ${safe.slice(0, 400)}`);
    process.exit(result.status ?? 1);
  }
  console.log(`set ${key}`);
}

const local = parseEnv(readFileSync(file, 'utf8'));
const copy = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_READ_URL',
  'SUPABASE_READ_SERVICE_ROLE_KEY',
  'WIRESTOCK_API_BASE_URL',
  'WIRESTOCK_API_TOKEN',
  'WIRESTOCK_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'GEMINI_CONCURRENCY',
  'GEMINI_CONCURRENCY_FLOOR',
  'GEMINI_CONCURRENCY_INITIAL',
  'GEMINI_OWNER_CONCURRENCY',
  'GEMINI_INCREASE_AFTER',
  'GEMINI_FILES_CONCURRENCY',
  'GEMINI_MOCK',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'SES_FROM_EMAIL',
  'SES_ASSIGNMENT_TEMPLATE',
  'SES_PROFILE_URL',
  'SES_UNSUBSCRIBE_URL',
];
for (const key of copy) {
  const value = local.get(key);
  if (!value) {
    console.log(`skip ${key}`);
    continue;
  }
  setVar(key, value);
}

setVar('AUTH_MODE', 'local');
setVar('STORAGE_DRIVER', 's3');
setVar('STORAGE_S3_ENDPOINT', '${{adaptable-toybox.ENDPOINT}}');
setVar('STORAGE_S3_BUCKET', '${{adaptable-toybox.BUCKET}}');
setVar('STORAGE_S3_ACCESS_KEY_ID', '${{adaptable-toybox.ACCESS_KEY_ID}}');
setVar('STORAGE_S3_SECRET_ACCESS_KEY', '${{adaptable-toybox.SECRET_ACCESS_KEY}}');
setVar('STORAGE_S3_REGION', '${{adaptable-toybox.REGION}}');
setVar('STORAGE_LOCAL_DIR', 'tmp/storage');
setVar('RUN_WORKER', service === 'gdp' ? '0' : '1');
setVar('SERVICE_KIND', service === 'worker' ? 'worker' : service === 'catchup' ? 'catchup' : 'web');
setVar('LIBREOFFICE_BIN', '/usr/bin/soffice');
setVar('BOOTSTRAP_ADMIN_EMAILS', 'george@wirestock.io');
setVar('PUBLIC_APP_URL', 'https://gdp-production-83d5.up.railway.app');
setVar('DATABASE_URL', '${{Postgres.DATABASE_URL}}');
console.log('done');
