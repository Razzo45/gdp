import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Copies SES keys from .env.local to Railway. Never prints values. */
const service = process.argv[2] ?? 'gdp';
const file = path.join(process.cwd(), '.env.local');
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
    const err = `${result.stderr ?? ''}${result.stdout ?? ''}`.replaceAll(value, '[redacted]').trim();
    console.error(`failed ${key}: ${err.slice(0, 400)}`);
    process.exit(result.status ?? 1);
  }
  console.log(`set ${key}`);
}

const local = parseEnv(readFileSync(file, 'utf8'));
const required = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SES_FROM_EMAIL'];
const optional = ['SES_ASSIGNMENT_TEMPLATE', 'SES_PROFILE_URL', 'SES_UNSUBSCRIBE_URL'];
const missing = required.filter((key) => !local.get(key));
if (missing.length) {
  console.error(`missing ${missing.join(', ')}`);
  process.exit(1);
}
for (const key of [...required, ...optional]) {
  const value = local.get(key);
  if (!value) {
    console.log(`skip ${key}`);
    continue;
  }
  setVar(key, value);
}
console.log('done');
