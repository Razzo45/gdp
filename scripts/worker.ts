import './env';
import { createServer } from 'node:http';
import { startWorker } from '@/lib/jobs/worker';

/** `npm run worker` — standalone job worker (set RUN_WORKER=0 on the web process). */
const handle = startWorker({ concurrency: Number(process.env['WORKER_CONCURRENCY'] ?? 2) });
console.log('[worker] started');

const port = Number(process.env['PORT'] ?? 0);
if (Number.isFinite(port) && port > 0) {
  createServer((req, res) => {
    const ok = req.url === '/health' || req.url === '/' || req.url === '/api/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(ok ? 'ok' : 'not found');
  }).listen(port, '0.0.0.0', () => console.log(`[worker] health on :${port}`));
}

const stop = () => {
  handle.stop().finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
