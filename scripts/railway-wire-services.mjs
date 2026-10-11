import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * Creates worker + catchup next to gdp and points them at Postgres / the
 * bucket / gdp secrets via Railway references. Never prints values.
 */

function run(args, input) {
  const result = spawnSync('npx', ['--yes', '@railway/cli', ...args], {
    encoding: 'utf8',
    shell: true,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).slice(0, 800));
  }
  return result.stdout;
}

function setVar(service, key, value) {
  const result = spawnSync('npx', ['--yes', '@railway/cli', 'variable', 'set', key, '--stdin', '--service', service, '--skip-deploys'], {
    input: value,
    encoding: 'utf8',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`set ${service}.${key}: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  console.log(`set ${service}.${key}`);
}

function ensureService(name) {
  const list = JSON.parse(run(['service', 'list', '--json']));
  const found = list.find((row) => row.name === name);
  if (found) {
    console.log(`have ${name} ${found.id}`);
    return found;
  }
  const created = JSON.parse(run(['add', '--service', name, '--json']));
  const id = created.id ?? created.serviceId ?? created.service?.id;
  if (!id) throw new Error(`Could not read id for ${name}: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`created ${name} ${id}`);
  return { id, name };
}

const shared = {
  AUTH_MODE: '${{gdp.AUTH_MODE}}',
  AUTH_LOCAL_SECRET: '${{gdp.AUTH_LOCAL_SECRET}}',
  DATABASE_URL: '${{Postgres.DATABASE_URL}}',
  STORAGE_DRIVER: '${{gdp.STORAGE_DRIVER}}',
  STORAGE_S3_ENDPOINT: '${{adaptable-toybox.ENDPOINT}}',
  STORAGE_S3_BUCKET: '${{adaptable-toybox.BUCKET}}',
  STORAGE_S3_ACCESS_KEY_ID: '${{adaptable-toybox.ACCESS_KEY_ID}}',
  STORAGE_S3_SECRET_ACCESS_KEY: '${{adaptable-toybox.SECRET_ACCESS_KEY}}',
  STORAGE_S3_REGION: '${{adaptable-toybox.REGION}}',
  SUPABASE_READ_URL: '${{gdp.SUPABASE_READ_URL}}',
  SUPABASE_READ_SERVICE_ROLE_KEY: '${{gdp.SUPABASE_READ_SERVICE_ROLE_KEY}}',
  NEXT_PUBLIC_SUPABASE_URL: '${{gdp.NEXT_PUBLIC_SUPABASE_URL}}',
};

const workerVars = {
  ...shared,
  SERVICE_KIND: 'worker',
  RUN_WORKER: '0',
  LIBREOFFICE_BIN: '/usr/bin/soffice',
  GEMINI_API_KEY: '${{gdp.GEMINI_API_KEY}}',
  GEMINI_CONCURRENCY: '${{gdp.GEMINI_CONCURRENCY}}',
  GEMINI_CONCURRENCY_FLOOR: '${{gdp.GEMINI_CONCURRENCY_FLOOR}}',
  GEMINI_CONCURRENCY_INITIAL: '${{gdp.GEMINI_CONCURRENCY_INITIAL}}',
  GEMINI_OWNER_CONCURRENCY: '${{gdp.GEMINI_OWNER_CONCURRENCY}}',
  GEMINI_INCREASE_AFTER: '${{gdp.GEMINI_INCREASE_AFTER}}',
  GEMINI_FILES_CONCURRENCY: '${{gdp.GEMINI_FILES_CONCURRENCY}}',
  GEMINI_MOCK: '${{gdp.GEMINI_MOCK}}',
};

const catchupVars = {
  ...shared,
  SERVICE_KIND: 'catchup',
  RUN_WORKER: '0',
};

const worker = ensureService('worker');
const catchup = ensureService('catchup');
setVar('gdp', 'RUN_WORKER', '0');
setVar('gdp', 'SERVICE_KIND', 'web');
for (const [key, value] of Object.entries(workerVars)) setVar('worker', key, value);
for (const [key, value] of Object.entries(catchupVars)) setVar('catchup', key, value);

const envId = '1951b16c-ea2a-4b5f-b80c-fa2d1133a1e8';
writeFileSync('tmp/railway-wire-vars.json', JSON.stringify({
  workerId: worker.id,
  catchupId: catchup.id,
  environmentId: envId,
}));
run(['api', '--file', 'scripts/railway-service-update.graphql', '--variables', '@tmp/railway-wire-vars.json']);
console.log('wired worker + catchup');
