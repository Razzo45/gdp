import { execFileSync } from 'node:child_process';
import './railway-target';

function loadCatalogToken(): void {
  if (process.env['WIRESTOCK_API_TOKEN']?.trim()) return;
  const raw = execFileSync('npx', ['@railway/cli', 'variables', '--service', 'gdp', '--json'], { encoding: 'utf8' });
  const vars = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ['WIRESTOCK_API_TOKEN', 'WIRESTOCK_API_BASE_URL'] as const) {
    const value = vars[key];
    if (typeof value === 'string' && value.trim()) process.env[key] = value;
  }
}

/** One-shot: land Catalog inbound / return statuses onto DATABASE_URL. */
async function main() {
  loadCatalogToken();
  if (!process.env['AUTH_MODE']) process.env['AUTH_MODE'] = 'local';
  const { reconcileWatchedCatalog } = await import('@/lib/services/catalogWatch');
  const result = await reconcileWatchedCatalog();
  console.log(`pulled=${result.pulled} failed=${result.failed}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
