import 'server-only';

import { NextResponse } from 'next/server';
import { sha256 } from '@/domain/fingerprint';
import { documentViewHtml, documentViewKind } from '@/lib/ai/documentView';
import { officePreviewKind, officePreviewPdf, rendererAvailable } from '@/lib/ai/media';
import { env } from '@/lib/env';

const MAX_OFFICE_PREVIEW_BYTES = 80 * 1024 * 1024;

export function wantsDownload(request: Request): boolean {
  return new URL(request.url).searchParams.get('download') === '1';
}

export function wantsThumb(request: Request): boolean {
  return new URL(request.url).searchParams.get('thumb') === '1';
}

export function wantsStandaloneView(request: Request): boolean {
  return new URL(request.url).searchParams.get('view') === '1';
}

const CATALOG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a live Catalog submission id (not a local fixture slug). */
export function isLiveCatalogId(id: string): boolean {
  return CATALOG_UUID.test(id);
}

/** Presigned Catalog URLs, plus leftover mock `localhost` hosts after switching to live. */
export function catalogUrlStale(url: string | null | undefined, catalogSubmissionId?: string): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const apiHost = new URL(env().WIRESTOCK_API_BASE_URL).hostname;
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    const liveApi = apiHost !== 'localhost' && apiHost !== '127.0.0.1';
    if (local && liveApi && (!catalogSubmissionId || isLiveCatalogId(catalogSubmissionId))) return true;
    const date = parsed.searchParams.get('X-Amz-Date');
    const expires = parsed.searchParams.get('X-Amz-Expires');
    if (!date || !expires) return false;
    const issued = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    return Number.isFinite(issued) && issued + Number(expires) * 1000 - 60_000 < Date.now();
  } catch {
    return true;
  }
}

export function downloadPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}?download=1`;
}

export function previewFallbackPage(name: string, downloadHref: string, message: string): Response {
  const safeName = escapeHtml(name);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${safeName}</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #09090b; color: #fafafa; font: 16px/1.5 Poppins, ui-sans-serif, system-ui, sans-serif; }
    main { min-height: 100dvh; display: grid; place-items: center; padding: 32px; }
    section { max-width: 36rem; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #a1a1aa; margin: 0 0 20px; }
    a { display: inline-flex; align-items: center; height: 36px; padding: 0 14px; border-radius: 8px; background: #6375ff; color: #fff; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${safeName}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="${escapeHtml(downloadHref)}">Download file</a>
    </section>
  </main>
</body>
</html>`;
  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/** Same-origin stream so the browser can play video / show PDF without S3 CORS. Range is forwarded. */
export async function proxyFile(url: string, request: Request, fallbackMime: string, filename: string): Promise<Response> {
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);
  const upstream = await fetch(url, { headers, redirect: 'follow', cache: 'no-store' });
  const out = new Headers();
  out.set('Content-Type', (upstream.headers.get('content-type') ?? fallbackMime).split(';')[0]!.trim() || fallbackMime);
  out.set('Cache-Control', 'private, max-age=60');
  out.set('Content-Disposition', `${wantsDownload(request) ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`);
  for (const key of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  if (range && !out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

export async function documentViewResponse(bytes: Uint8Array, name: string, mime: string, downloadHref: string): Promise<Response> {
  if (bytes.byteLength > MAX_OFFICE_PREVIEW_BYTES) {
    return previewFallbackPage(name, downloadHref, 'This file is too large to preview. Download it instead.');
  }
  if (!documentViewKind(name, mime)) {
    return officePreviewResponse(bytes, name, mime, { downloadHref });
  }
  try {
    const html = await documentViewHtml(bytes, name, mime, downloadHref);
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=120' },
    });
  } catch {
    return previewFallbackPage(name, downloadHref, 'The file could not be read for preview. Download it instead.');
  }
}

export async function officePreviewResponse(bytes: Uint8Array, name: string, mime: string, fallback?: { downloadHref: string }): Promise<Response> {
  const kind = officePreviewKind(name, mime);
  const fail = (status: number, error: string) =>
    fallback ? previewFallbackPage(name, fallback.downloadHref, error) : NextResponse.json({ error }, { status });
  if (!kind) return fail(422, 'That file is not an Office document.');
  if (bytes.byteLength > MAX_OFFICE_PREVIEW_BYTES) return fail(413, 'This Office file is too large to preview. Download it instead.');
  if (!(await rendererAvailable())) return fail(503, 'This Office file is a legacy binary format and cannot be previewed here. Download it instead.');
  const pdf = await officePreviewPdf(bytes, sha256(bytes), kind);
  if (!pdf) return fail(422, 'The Office file could not be rendered for preview. Download it instead.');
  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name.replace(/\.[a-z0-9]+$/i, '')}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}

const BROWSER_NATIVE = /^(image\/|video\/|audio\/|application\/pdf|text\/)/;

export function browserCanShow(mime: string, name: string): boolean {
  if (BROWSER_NATIVE.test(mime)) return true;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'txt', 'md', 'csv', 'json', 'html'].includes(ext);
}
