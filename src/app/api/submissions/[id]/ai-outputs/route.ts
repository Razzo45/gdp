import { json, route } from '@/lib/api';
import { MAX_FILE_BYTES } from '@/lib/ai/media';
import { addAiOutput } from '@/lib/services/files';

/** Small-file fallback. Anything over 8 MB must use the signed PUT (upload-url). */
export const POST = route({}, async ({ actor, params, request }) => {
  const claimed = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(claimed) && claimed > 8 * 1024 * 1024) {
    return json({ error: 'This file is too large to send through the app. Reload and use the signed upload.' }, 413);
  }
  if (Number.isFinite(claimed) && claimed > MAX_FILE_BYTES + 64 * 1024) return json({ error: `Files above ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB cannot be graded.` }, 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return json({ error: 'Attach a file under the "file" field.' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await addAiOutput(actor, params['id']!, { name: file.name, mime: file.type, bytes });
  return { file: row };
});
