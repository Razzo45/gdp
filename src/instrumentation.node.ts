import { startCatalogWatch } from '@/lib/catalog/watchLoop';
import { startWorker } from '@/lib/jobs/worker';

const boot = globalThis as typeof globalThis & { __gdpWorkerStarted?: boolean };

/** Runs the job queue inside the web process; stops cleanly on SIGTERM/SIGINT. */
export function startEmbeddedWorker(): void {
  if (boot.__gdpWorkerStarted) return;
  boot.__gdpWorkerStarted = true;
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? 8);
  console.log(`[worker] embedded worker starting (concurrency ${concurrency}, pid ${process.pid})`);
  const handle = startWorker({ concurrency });
  startCatalogWatch();
  const stop = () => {
    handle.stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
