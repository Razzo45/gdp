import { reconcilePendingAutocookIngests } from '@/lib/services/autocook';

const boot = globalThis as typeof globalThis & { __gdpAutocookIngestWatchStarted?: boolean };

/**
 * Pull finished Autocook deliverables into AI outputs even when no task page is open.
 * Mirrors catalog-watch: process boot, interval, skip overlap.
 */
export function startAutocookIngestWatch(): void {
  if (boot.__gdpAutocookIngestWatchStarted) return;
  if ((process.env['AUTOCOOK_INGEST_WATCH'] ?? '1') === '0') {
    console.log('[autocook-ingest] disabled (AUTOCOOK_INGEST_WATCH=0)');
    return;
  }
  boot.__gdpAutocookIngestWatchStarted = true;
  const intervalMs = Number(process.env['AUTOCOOK_INGEST_MS'] ?? 20_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcilePendingAutocookIngests();
      if (result.ingested || result.failed) console.log('[autocook-ingest]', result);
    } catch (error) {
      console.warn('[autocook-ingest] failed', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const ms = Number.isFinite(intervalMs) && intervalMs >= 10_000 ? intervalMs : 20_000;
  console.log(`[autocook-ingest] watching finished cooks every ${ms}ms`);
  void tick();
  setInterval(() => void tick(), ms);
}
