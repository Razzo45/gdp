import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { allFiles, HANDOFF_STATUS, MIME, project, QA_STATUS, submissions, WORK_STATUS, type FixtureFile } from './mock/fixtures';

/**
 * Fake Data Program (Catalog) API for local development.
 *
 *   GET  /projects/:id
 *   GET  /project-submissions/:id                 (fresh "presigned" file URLs each call)
 *   PUT  /project-submissions/:id/save            { projectId, submission }
 *   POST /project-submissions/:id/make-transition { projectId, destinationSubmissionStatusId, note? }
 *   GET  /project-submissions/:id/files/upload-url?fileExtension=&fileName=
 *   PUT  /upload/:name                            (target of the upload-url)
 *   GET  /files/:fileId                           (bytes; honours X-Amz-Expires)
 *   POST /emit/:submissionId                      sends a signed webhook to the app
 *   GET  /state                                   what was saved / moved so far
 *
 * Env: MOCK_CATALOG_PORT (4010), APP_URL (http://localhost:3000),
 *      WIRESTOCK_WEBHOOK_SECRET (used to sign /emit deliveries).
 */

const port = Number(process.env['MOCK_CATALOG_PORT'] ?? 4010);
const appUrl = (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
const webhookSecret = process.env['WIRESTOCK_WEBHOOK_SECRET'] ?? 'local-webhook-secret';
const base = `http://localhost:${port}`;

const state = {
  status: new Map<string, string>(submissions.map((s) => [s.id, WORK_STATUS])),
  saved: new Map<string, Record<string, unknown>>(),
  log: [] as { at: string; what: string; detail: unknown }[],
  uploads: new Map<string, number>(),
};
const note = (what: string, detail: unknown) => {
  state.log.push({ at: new Date().toISOString(), what, detail });
  console.log(`[mock-catalog] ${what}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
};

const fileCache = new Map<string, Promise<Uint8Array>>();
const bytesFor = (f: FixtureFile) => {
  let p = fileCache.get(f.id);
  if (!p) {
    p = f.build();
    fileCache.set(f.id, p);
  }
  return p;
};
const fileById = new Map(allFiles().map((f) => [f.id, f]));

const amzDate = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const presigned = (f: FixtureFile) => `${base}/files/${f.id}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${amzDate()}&X-Amz-Expires=3600&X-Amz-Signature=${f.id.slice(-8)}`;

function submissionPayload(id: string) {
  const s = submissions.find((x) => x.id === id);
  if (!s) return null;
  const statusId = state.status.get(id) ?? WORK_STATUS;
  const files = [...s.inputs, ...s.golden].map((f) => ({ projectSubmissionFileId: f.id, extension: f.extension, originalFileName: f.name, type: 'file', urls: { download: presigned(f) } }));
  const transitions = project.workflow.transitions.filter((t) => t.from === statusId).map((t) => ({ destinationSubmissionStatusId: t.to, note: t.notes ?? null }));
  return {
    projectId: project.projectId,
    projectSubmissionId: s.id,
    submission: {
      ...s.values,
      inputFiles: s.inputs.map((f) => ({ inputFile: f.id })),
      goldenOutput: s.golden.map((f) => ({ goldenFile: f.id })),
      ...(state.saved.get(id) ?? {}),
    },
    files,
    media: [],
    user: s.author,
    workflowState: { statusId, transitions },
  };
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(text);
};

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

async function emitWebhook(submissionId: string): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    eventId: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    eventType: 'submission.status-changed',
    occurredAt: new Date().toISOString(),
    projectId: project.projectId,
    submissionId,
    status: state.status.get(submissionId) ?? WORK_STATUS,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(`${appUrl}/api/hooks/wirestock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wirestock-signature': `keyId=mock,sha256=${digest}`, 'x-wirestock-timestamp': timestamp },
    body,
  });
  return { status: response.status, body: await response.text() };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', base);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && parts[0] === 'state') return send(res, 200, { status: Object.fromEntries(state.status), saved: Object.fromEntries(state.saved), uploads: Object.fromEntries(state.uploads), log: state.log });

    if (method === 'GET' && parts[0] === 'project-submissions' && !parts[1]) {
      const projectId = url.searchParams.get('projectId');
      if (projectId && projectId !== project.projectId) return send(res, 400, { title: 'Unknown project' });
      const data = submissions.map((s) => ({
        projectId: project.projectId,
        projectSubmissionId: s.id,
        workflowState: { statusId: state.status.get(s.id) ?? WORK_STATUS },
        transitionLog: [],
        updatedAt: new Date().toISOString(),
      }));
      return send(res, 200, { data, metadata: { pagination: { total: data.length, count: data.length, perPage: 100, page: 1, totalPages: 1, links: null } } });
    }

    if (method === 'GET' && parts[0] === 'projects' && parts[1]) {
      return decodeURIComponent(parts[1]) === project.projectId ? send(res, 200, project) : send(res, 404, { error: 'no such project' });
    }

    if (method === 'GET' && parts[0] === 'files' && parts[1]) {
      const f = fileById.get(parts[1]);
      if (!f) return send(res, 404, 'no such file');
      const issued = url.searchParams.get('X-Amz-Date') ?? '';
      const ttl = Number(url.searchParams.get('X-Amz-Expires') ?? '0');
      const issuedMs = Date.parse(issued.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      if (Number.isFinite(issuedMs) && ttl && issuedMs + ttl * 1000 < Date.now()) return send(res, 403, '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>');
      const bytes = await bytesFor(f);
      res.writeHead(200, { 'Content-Type': MIME[f.extension] ?? 'application/octet-stream', 'Content-Length': String(bytes.byteLength) });
      return res.end(Buffer.from(bytes));
    }

    if (parts[0] === 'project-submissions' && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      const payload = submissionPayload(id);
      if (!payload) return send(res, 404, { error: 'no such submission' });

      if (method === 'GET' && parts.length === 2) return send(res, 200, payload);

      if (method === 'PUT' && parts[2] === 'save') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { projectId?: string; submission?: Record<string, unknown> };
        if (body.projectId !== project.projectId) return send(res, 400, 'projectId mismatch');
        if (!body.submission || typeof body.submission !== 'object') return send(res, 400, 'submission must be an object');
        const rubrics = body.submission['rubrics'];
        if (rubrics !== undefined && !Array.isArray(rubrics)) return send(res, 422, 'rubrics must be an array');
        for (const [k, v] of Object.entries(body.submission)) {
          if (typeof v === 'string' && /[^\x00-\x7f]/.test(v)) return send(res, 422, `field ${k} contains non-ASCII characters`);
        }
        state.saved.set(id, body.submission);
        note('save', { id, keys: Object.keys(body.submission), rubricRows: Array.isArray(rubrics) ? rubrics.length : 0 });
        return send(res, 200, { ok: true });
      }

      if (method === 'POST' && parts[2] === 'make-transition') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { projectId?: string; destinationSubmissionStatusId?: string; note?: string };
        const from = state.status.get(id) ?? WORK_STATUS;
        const edge = project.workflow.transitions.find((t) => t.from === from && t.to === body.destinationSubmissionStatusId);
        if (!edge) return send(res, 409, `no transition from ${from} to ${body.destinationSubmissionStatusId}`);
        if (edge.notes?.isRequired && !body.note) return send(res, 422, 'a note is required for this transition');
        state.status.set(id, edge.to);
        note('transition', { id, from, to: edge.to, trigger: edge.trigger });
        return send(res, 200, { ok: true, statusId: edge.to });
      }

      if (method === 'GET' && parts[2] === 'files' && parts[3] === 'upload-url') {
        const ext = url.searchParams.get('fileExtension') ?? 'bin';
        const name = url.searchParams.get('fileName') ?? `upload.${ext}`;
        const fileId = `up-${Date.now().toString(36)}`;
        return send(res, 200, { url: `${base}/upload/${encodeURIComponent(name)}`, headers: [{ key: 'x-amz-meta-attribute-file-id', value: fileId }] });
      }
    }

    if (method === 'PUT' && parts[0] === 'upload' && parts[1]) {
      const bytes = await readBody(req);
      state.uploads.set(decodeURIComponent(parts[1]), bytes.byteLength);
      note('upload', { name: decodeURIComponent(parts[1]), bytes: bytes.byteLength });
      return send(res, 200, '');
    }

    if (method === 'POST' && parts[0] === 'emit' && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      if (!submissions.some((s) => s.id === id)) return send(res, 404, { error: 'no such submission' });
      const result = await emitWebhook(id);
      note('webhook', { id, appStatus: result.status, appBody: result.body });
      return send(res, 200, result);
    }

    return send(res, 404, { error: `mock catalog: no route for ${method} ${url.pathname}` });
  } catch (error) {
    note('error', error instanceof Error ? error.message : String(error));
    return send(res, 500, { error: 'mock catalog failure' });
  }
});

server.listen(port, () => {
  console.log(`[mock-catalog] listening on ${base}`);
  console.log(`[mock-catalog] project ${project.projectId}: work=${WORK_STATUS} qa=${QA_STATUS} handoff=${HANDOFF_STATUS}`);
  for (const s of submissions) console.log(`[mock-catalog]   submission ${s.id}  (emit webhook: curl -X POST ${base}/emit/${s.id})`);
  console.log(`[mock-catalog] app: ${appUrl}  webhook secret: ${webhookSecret === 'local-webhook-secret' ? '(default)' : '(from env)'}`);
});
