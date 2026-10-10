import 'server-only';

import { NextResponse } from 'next/server';
import { sha256 } from '@/domain/fingerprint';
import { officePreviewKind, officePreviewPdf, rendererAvailable } from '@/lib/ai/media';

const MAX_OFFICE_PREVIEW_BYTES = 80 * 1024 * 1024;

export function wantsDownload(request: Request): boolean {
  return new URL(request.url).searchParams.get('download') === '1';
}

export function wantsOfficePreview(request: Request, name: string, mime: string): boolean {
  return new URL(request.url).searchParams.get('preview') === '1' && officePreviewKind(name, mime) !== null;
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

export async function officePreviewResponse(bytes: Uint8Array, name: string, mime: string): Promise<Response> {
  const kind = officePreviewKind(name, mime);
  if (!kind) return NextResponse.json({ error: 'That file is not an Office document.' }, { status: 422 });
  if (bytes.byteLength > MAX_OFFICE_PREVIEW_BYTES) {
    return NextResponse.json({ error: 'This Office file is too large to preview in the page. Download it instead.' }, { status: 413 });
  }
  if (!(await rendererAvailable())) {
    return NextResponse.json({ error: 'LibreOffice is not installed on this server, so Office files cannot be previewed. Download the file.' }, { status: 503 });
  }
  const pdf = await officePreviewPdf(bytes, sha256(bytes), kind);
  if (!pdf) return NextResponse.json({ error: 'The Office file could not be rendered for preview. Download it instead.' }, { status: 422 });
  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name.replace(/\.[a-z0-9]+$/i, '')}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
