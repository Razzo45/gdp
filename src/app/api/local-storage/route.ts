import { json } from '@/lib/api';
import { readLocalSigned, writeLocalSigned } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** Serves STORAGE_DRIVER=local objects behind the signed URLs `signedUrl` issues. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const objectPath = url.searchParams.get('path') ?? '';
  const expires = url.searchParams.get('expires') ?? '';
  const signature = url.searchParams.get('sig') ?? '';
  const found = await readLocalSigned(objectPath, expires, signature);
  if (!found) return json({ error: 'That link is invalid or has expired.' }, 404);
  const name = objectPath.split('/').pop() ?? 'file';
  const bytes = found.bytes;
  const range = request.headers.get('range');
  const headers = {
    'Content-Type': found.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `inline; filename="${name.replace(/[^\w.-]/g, '_')}"`,
  };
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : bytes.byteLength - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= bytes.byteLength || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
    }
    return new Response(Buffer.from(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}` },
    });
  }
  return new Response(Buffer.from(bytes), {
    headers: { ...headers, 'Content-Length': String(bytes.byteLength) },
  });
}

/** Receives a signed PUT from the browser. Auth is the HMAC, not the session. */
export async function PUT(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const objectPath = url.searchParams.get('path') ?? '';
  const expires = url.searchParams.get('expires') ?? '';
  const signature = url.searchParams.get('sig') ?? '';
  const mime = (request.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() || 'application/octet-stream';
  const ok = await writeLocalSigned(objectPath, expires, signature, request.body, mime);
  if (!ok) return json({ error: 'That upload link is invalid or has expired.' }, 404);
  return new Response(null, { status: 204 });
}
