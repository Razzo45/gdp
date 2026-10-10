/**
 * Next.js calls `register` once per server process. On Replit the web
 * process is the only process, so the job worker runs here unless
 * RUN_WORKER=0 (then run `npm run worker` separately).
 *
 * The Node-only part lives in `instrumentation.node.ts` so the edge bundle
 * never sees `process.exit` / signal handlers.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  if ((process.env['RUN_WORKER'] ?? '1') === '0') {
    console.log('[worker] disabled (RUN_WORKER=0)');
    return;
  }
  const { startEmbeddedWorker } = await import('./instrumentation.node');
  startEmbeddedWorker();
}
