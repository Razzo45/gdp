import { reconcileWatchedCatalog } from '@/lib/services/catalogWatch';

const boot = globalThis as typeof globalThis & { __gdpCatalogWatchStarted?: boolean };

/** Periodically land Catalog pickup and platform-return statuses on the board. */
export function startCatalogWatch(): void {
  if (boot.__gdpCatalogWatchStarted) return;
  if ((process.env['CATALOG_WATCH'] ?? '1') === '0') {
    console.log('[catalog-watch] disabled (CATALOG_WATCH=0)');
    return;
  }
  boot.__gdpCatalogWatchStarted = true;
  const intervalMs = Number(process.env['CATALOG_WATCH_MS'] ?? 60_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileWatchedCatalog();
      if (result.pulled || result.failed) console.log('[catalog-watch]', result);
    } catch (error) {
      console.warn('[catalog-watch] failed', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  console.log(`[catalog-watch] watching inbound Catalog statuses every ${intervalMs}ms`);
  void tick();
  setInterval(() => void tick(), Number.isFinite(intervalMs) && intervalMs >= 15_000 ? intervalMs : 60_000);
}
