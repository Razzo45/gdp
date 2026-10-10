import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads .env.local then .env into process.env for CLI scripts (Next does
 * this for the web process; tsx does not). Existing variables win.
 */
for (const name of ['.env.local', '.env']) {
  const file = path.join(process.cwd(), name);
  if (!existsSync(file)) continue;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
