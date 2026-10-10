import './env';
import { startWorker } from '@/lib/jobs/worker';

/** `npm run worker` â€” standalone job worker (set RUN_WORKER=0 on the web process). */
const handle = startWorker({ concurrency: Number(process.env['WORKER_CONCURRENCY'] ?? 2) });
console.log('[worker] started');
const stop = () => {
  handle.stop().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
