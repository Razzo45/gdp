/**
 * Force the helper sandbox onto file-backed PGlite so a Railway / Neon
 * DATABASE_URL in .env.local cannot be written by accident.
 *
 * Keep the data dir outside the repo. PGlite WAL flushes inside tmp/
 * make Turbopack recompile on every request, which remounts the page
 * and flashes light/dark.
 */
import './env';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sourceUrlFromDotenv(): string {
  for (const name of ['.env.local', '.env']) {
    const file = join(process.cwd(), name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.startsWith('DATABASE_URL=')) continue;
      let value = line.slice('DATABASE_URL='.length).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return value;
    }
  }
  return '';
}

const loaded = process.env['GDP_SOURCE_DATABASE_URL'] || process.env['DATABASE_URL'] || '';
const fromFile = sourceUrlFromDotenv();
const source = !loaded.startsWith('pglite:') ? loaded : fromFile;
if (source && !source.startsWith('pglite:')) process.env['GDP_SOURCE_DATABASE_URL'] = source;

const sandboxDir = join(tmpdir(), 'gdp-helper-sandbox');
const leftover = join(process.cwd(), 'tmp', 'gdp-helper');
if (existsSync(leftover) && !existsSync(sandboxDir)) {
  cpSync(leftover, sandboxDir, { recursive: true });
}
process.env['DATABASE_URL'] = `pglite:${sandboxDir}`;
process.env['AUTH_MODE'] = 'local';
process.env['AUTH_LOCAL_SECRET'] = process.env['AUTH_LOCAL_SECRET'] || 'local-dev-secret-change-me';
process.env['AUTH_LOCAL_PASSWORD'] = process.env['AUTH_LOCAL_PASSWORD'] || 'gdp-dev';
process.env['GEMINI_MOCK'] = '1';
delete process.env['GEMINI_API_KEY'];
delete process.env['GOOGLE_API_KEY'];
delete process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
process.env['STORAGE_DRIVER'] = 'local';
process.env['STORAGE_LOCAL_DIR'] = 'tmp/storage';
process.env['RUN_WORKER'] = '1';
process.env['CATALOG_WATCH'] = '0';
process.env['SHEETS_SYNC'] = '0';
process.env['PUBLIC_APP_URL'] = 'http://localhost:3000';
process.env['WIRESTOCK_API_BASE_URL'] = process.env['WIRESTOCK_API_BASE_URL'] || 'http://localhost:4010';
process.env['WIRESTOCK_API_TOKEN'] = process.env['WIRESTOCK_API_TOKEN'] || 'mock';
process.env['WIRESTOCK_WEBHOOK_SECRET'] = process.env['WIRESTOCK_WEBHOOK_SECRET'] || 'local-webhook-secret';
