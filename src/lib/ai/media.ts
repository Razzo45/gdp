import 'server-only';

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { db } from '@/db/client';
import { derivatives } from '@/db/schema';
import { sha256 } from '@/domain/fingerprint';
import { env } from '@/lib/env';
import { getObject, putObject } from '@/lib/storage';
import { describeFileFacts, describeFileFactsAsync } from './fileFacts';
import { mediaPart, type MediaPart } from './gemini';
import { officeEmbeddedImages, officeManifest, officePreviewKind, officeTextDigest, type OfficeKind, type OfficePreviewKind } from './office';
import { MAX_RENDERED_PAGES, rasterizePdfPages } from './pdfPages';

export type { OfficePreviewKind };
export { officePreviewKind };

const OOXML: readonly OfficeKind[] = ['pptx', 'docx', 'xlsx'];
const isOoxml = (kind: OfficePreviewKind): kind is OfficeKind => (OOXML as readonly string[]).includes(kind);

/**
 * Turns a deliverable (golden or AI output, or a task input) into Gemini parts.
 *
 *  - Images, video, audio, PDF and plain text go to the model as-is.
 *  - PPTX/DOCX/XLSX are rendered to PDF once per content hash (LibreOffice,
 *    cached in the private bucket via `app.derivatives`) and the model gets
 *    the PDF *plus* a deterministic manifest read from the OOXML itself
 *    (slide count, aspect ratio, notes, embedded media, fonts). Format facts
 *    are therefore verified against the file, not against a render.
 *  - Without a renderer the manifest and a full text digest are sent and the
 *    label says so, so visual statements are answered No for a stated reason
 *    instead of being guessed.
 *  - ZIP deliverables are expanded into their files (bounded).
 *  - Anything else becomes a notice. The model is never handed bytes it
 *    cannot read and never asked to grade something it did not receive.
 */

export interface SourceFile {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type Delivery = 'native' | 'pdf_from_office' | 'text_digest' | 'archive' | 'unsupported';

export interface PreparedFile {
  id: string;
  name: string;
  parts: (string | MediaPart)[];
  /** How the file reached the model. Stored on the rating as evidence. */
  delivery: Delivery;
  sha256: string;
  bytes: number;
}

/** Rebuild a prepared native file from a live Files API handle — no bytes, no upload. */
export function preparedFromUri(input: { id: string; name: string; mime: string; sha256: string; size: number; uri: string; role: string }): PreparedFile {
  const label = `${input.role}: ${input.name} (id ${input.id})`;
  return {
    id: input.id,
    name: input.name,
    sha256: input.sha256,
    bytes: input.size,
    delivery: 'native',
    parts: [`${label}\n${describeFileFacts({ name: input.name, mime: input.mime, size: input.size })}`, { kind: 'uri', mime: input.mime, data: input.uri, label }],
  };
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT_CHARS = 40_000;
const MAX_ARCHIVE_ENTRIES = 25;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

const NATIVE_MIME = /^(image\/(png|jpe?g|webp|heic|heif|gif)|video\/|audio\/|application\/pdf|text\/)/;
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'text/plain', srt: 'text/plain',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  zip: 'application/zip',
};

export function normaliseMime(name: string, mime: string): string {
  const clean = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (clean && clean !== 'application/octet-stream' && clean !== 'binary/octet-stream') return clean;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXT_MIME[ext] || 'application/octet-stream';
}

export async function prepareFile(file: SourceFile, role: string, depth = 0): Promise<PreparedFile> {
  const digest = sha256(file.bytes);
  const mime = normaliseMime(file.name, file.mime);
  const label = `${role}: ${file.name} (id ${file.id})`;
  const base = { id: file.id, name: file.name, sha256: digest, bytes: file.bytes.byteLength };

  if (file.bytes.byteLength === 0) {
    return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: the file is empty.`] };
  }
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: file is ${mb(file.bytes.byteLength)} MB, above the ${mb(MAX_FILE_BYTES)} MB grading limit.`] };
  }

  const facts = await describeFileFactsAsync({ name: file.name, mime, size: file.bytes.byteLength, bytes: file.bytes });

  if (mime === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const text = Buffer.from(file.bytes).toString('utf8');
    return { ...base, delivery: 'text_digest', parts: [`${label}\n${facts}\nSVG markup (not rasterised):\n${clip(text)}\n--- end ---`] };
  }

  if (NATIVE_MIME.test(mime)) {
    if (mime.startsWith('text/')) {
      const text = Buffer.from(file.bytes).toString('utf8');
      const html = mime === 'text/html' || /\.html?$/i.test(file.name);
      // Long text (especially HTML prototypes) must not go in the prompt
      // string. tightenSendParts clips every string to 12k, which cut this
      // task's 84k HTML at the Categories label and made raters invent
      // incomplete_generation. Attach the file like a PDF instead.
      if (html || text.length > MAX_TEXT_CHARS) {
        return {
          ...base,
          delivery: 'native',
          parts: [
            `${label}\n${facts}\n${html ? 'HTML' : 'Text'} attached in full (${text.length} chars). Inspect the attached file, not a clipped digest.`,
            await mediaPart({ bytes: file.bytes, mime, sha256: digest, name: file.name, label }),
          ],
        };
      }
      return { ...base, delivery: 'native', parts: [`${label}\n${facts}\n--- file text (${text.length} chars) ---\n${text}\n--- end ---`] };
    }
    return { ...base, delivery: 'native', parts: [`${label}\n${facts}`, await mediaPart({ bytes: file.bytes, mime, sha256: digest, name: file.name, label })] };
  }

  const office = officePreviewKind(file.name, mime);
  if (office) return prepareOffice(file, office, label, base);

  if (mime === 'application/zip' || /\.zip$/i.test(file.name)) {
    if (depth > 0) return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: nested archives are not expanded.`] };
    return prepareArchive(file, role, label, base);
  }

  return {
    ...base,
    delivery: 'unsupported',
    parts: [`${label}\nNOT ATTACHED: ${mime} is not a format the grader can read. Statements that depend on its content must be answered No, with that reason as evidence.`],
  };
}

/* ─────────────────────────────────────────────── Office ── */

async function prepareOffice(file: SourceFile, kind: OfficePreviewKind, label: string, base: Omit<PreparedFile, 'parts' | 'delivery'>): Promise<PreparedFile> {
  const ooxml = isOoxml(kind);
  const [manifest, pdf, text] = await Promise.all([
    ooxml ? officeManifest(file.bytes, kind).catch(() => null) : Promise.resolve(null),
    renderedPdf(file.bytes, base.sha256, kind),
    ooxml ? officeTextDigest(file.bytes, kind).catch(() => '') : Promise.resolve(''),
  ]);
  const measured = describeFileFacts({ name: file.name, mime: file.mime, size: file.bytes.byteLength });
  const facts = `\n${measured}${manifest ? `\n${manifest}` : ''}`;
  const digest = text ? `\n--- text digest ---\n${clip(text)}\n--- end ---` : '';

  if (pdf) {
    const pages = await rasterizePdfPages(pdf).catch(() => []);
    if (pages.length > 0) {
      const unit = kind === 'pptx' || kind === 'ppt' ? 'slide' : 'page';
      const extra = pages.length === MAX_RENDERED_PAGES ? ` First ${MAX_RENDERED_PAGES} ${unit}s only.` : '';
      const pageParts = await Promise.all(
        pages.map((page) =>
          mediaPart({
            bytes: page.bytes,
            mime: page.mime,
            sha256: sha256(page.bytes),
            name: `${file.name.replace(/\.[a-z0-9]+$/i, '')}-${unit}-${page.index}.jpg`,
            label: `${label} — ${unit} ${page.index} of ${pages.length}`,
          }),
        ),
      );
      return {
        ...base,
        delivery: 'pdf_from_office',
        parts: [
          `${label}${facts}\n${pages.length} ${unit}(s) rendered as images below. Inspect each image for layout, colour, typography and photographs. FILE FACTS remain authoritative for counts, fonts and aspect. Animations, transitions and embedded video are not in the stills.${extra}${digest}`,
          ...pageParts,
        ],
      };
    }
    return {
      ...base,
      delivery: 'pdf_from_office',
      parts: [
        `${label}${facts}\nThe deliverable is attached below as a PDF render of the ${kind.toUpperCase()}. Animations, transitions and embedded video are not visible in the render; use FILE FACTS and the text digest for them.${digest}`,
        await mediaPart({ bytes: pdf, mime: 'application/pdf', sha256: sha256(pdf), name: file.name.replace(/\.[a-z0-9]+$/i, '.pdf'), label: `${label} — PDF render` }),
      ],
    };
  }

  const embedded = ooxml ? await officeEmbeddedImages(file.bytes, kind).catch(() => []) : [];
  const imageParts = await Promise.all(
    embedded.map((img, i) =>
      mediaPart({
        bytes: img.bytes,
        mime: img.mime,
        sha256: sha256(img.bytes),
        name: img.name,
        label: `${label} — embedded ${img.name} (${i + 1}/${embedded.length})`,
      }),
    ),
  );
  const renderNote = embedded.length
    ? `NO FULL-PAGE RENDER: LibreOffice did not produce a PDF. ${embedded.length} embedded image(s) from the package are attached. FILE FACTS are authoritative for counts, fonts, aspect and media presence. Judge photograph/asset claims from the attached images. Only answer No with "no render available" for slide-level layout, spacing or typography you cannot see.`
    : `NO RENDER AVAILABLE: only the text content below was extracted. Visual statements that need a page layout, colour or typography appearance cannot be verified and must be answered No with evidence "no render available". FILE FACTS still support format counts and embedded-media presence.`;

  return {
    ...base,
    delivery: 'text_digest',
    parts: [
      `${label}${facts}\n${renderNote}${digest || '\n--- text digest ---\n(the package could not be read)\n--- end ---'}`,
      ...imageParts,
    ],
  };
}

const RENDER_TOOL = 'libreoffice-pdf-v1';

/** PDF render of an Office file, converted at most once per source hash. */
/** PDF render of an Office file, converted at most once per source hash. Used by the grader and the on-page viewer. */
export async function officePreviewPdf(bytes: Uint8Array, sourceSha: string, kind: OfficePreviewKind): Promise<Uint8Array | null> {
  return renderedPdf(bytes, sourceSha, kind);
}

async function renderedPdf(bytes: Uint8Array, sourceSha: string, kind: OfficePreviewKind): Promise<Uint8Array | null> {
  const database = db();
  const cached = (
    await database
      .select()
      .from(derivatives)
      .where(and(eq(derivatives.sourceSha256, sourceSha), eq(derivatives.kind, 'pdf')))
      .limit(1)
  )[0];
  if (cached) {
    const stored = await getObject(cached.storagePath);
    if (stored && sha256(stored) === cached.sha256) return stored;
    await database.delete(derivatives).where(and(eq(derivatives.sourceSha256, sourceSha), eq(derivatives.kind, 'pdf')));
  }

  const pdf = await convertWithLibreOffice(bytes, kind);
  if (!pdf) return null;
  const path = `derivatives/${sourceSha}.pdf`;
  await putObject(path, pdf, 'application/pdf');
  await database
    .insert(derivatives)
    .values({ sourceSha256: sourceSha, kind: 'pdf', storagePath: path, mime: 'application/pdf', size: pdf.byteLength, sha256: sha256(pdf), tool: RENDER_TOOL })
    .onConflictDoUpdate({ target: [derivatives.sourceSha256, derivatives.kind], set: { storagePath: path, size: pdf.byteLength, sha256: sha256(pdf), tool: RENDER_TOOL } });
  return pdf;
}

/* ─────────────────────────────────────────── LibreOffice ── */

let libreOffice: Promise<string | null> | null = null;
let conversionsActive = 0;
const conversionQueue: (() => void)[] = [];
const MAX_CONVERSIONS = 2;

function windowsSofficeCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'];
  return [...new Set(roots.filter(Boolean))].map((root) => join(root!, 'LibreOffice', 'program', 'soffice.exe'));
}

function fileUrl(path: string): string {
  const unix = path.replace(/\\/g, '/');
  return unix.startsWith('/') ? `file://${unix}` : `file:///${unix}`;
}

function libreOfficeBinary(): Promise<string | null> {
  libreOffice ??= (async () => {
    const configured = env().LIBREOFFICE_BIN;
    const bins = configured ? [configured] : ['soffice', 'soffice.exe', 'libreoffice', ...windowsSofficeCandidates()];
    for (const bin of bins) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(bin, ['--version'], { stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
      });
      if (ok) return bin;
    }
    return null;
  })();
  return libreOffice;
}

export async function rendererAvailable(): Promise<boolean> {
  return (await libreOfficeBinary()) !== null;
}

async function convertWithLibreOffice(bytes: Uint8Array, kind: OfficePreviewKind): Promise<Uint8Array | null> {
  const bin = await libreOfficeBinary();
  if (!bin) return null;
  if (conversionsActive >= MAX_CONVERSIONS) await new Promise<void>((resolve) => conversionQueue.push(resolve));
  conversionsActive += 1;
  const dir = await mkdtemp(join(tmpdir(), 'gdp-office-'));
  try {
    const input = join(dir, `source.${kind}`);
    await writeFile(input, bytes);
    const profile = `${fileUrl(join(dir, 'profile'))}`;
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(/* turbopackIgnore: true */ bin, ['--headless', '--norestore', '--nologo', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', dir, input], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 180_000);
      child.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) return null;
    const named = await readFile(join(dir, 'source.pdf')).catch(() => null);
    if (named && named.byteLength > 0) return new Uint8Array(named);
    const found = (await readdir(dir)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!found) return null;
    const pdf = await readFile(join(dir, found)).catch(() => null);
    return pdf && pdf.byteLength > 0 ? new Uint8Array(pdf) : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    conversionsActive -= 1;
    conversionQueue.shift()?.();
  }
}

/* ─────────────────────────────────────────────── Archives ── */

async function prepareArchive(file: SourceFile, role: string, label: string, base: Omit<PreparedFile, 'parts' | 'delivery'>): Promise<PreparedFile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file.bytes);
  } catch {
    return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: the archive could not be opened.`] };
  }
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(e.name) && !e.name.split('/').pop()?.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const listing = entries.map((e) => `  - ${e.name}`).join('\n');
  const parts: (string | MediaPart)[] = [`${label}\n${describeFileFacts({ name: file.name, mime: file.mime, size: file.bytes.byteLength })}\nARCHIVE with ${entries.length} file(s):\n${listing || '  (empty)'}`];
  let budget = MAX_ARCHIVE_BYTES;
  for (const entry of entries.slice(0, MAX_ARCHIVE_ENTRIES)) {
    const bytes = new Uint8Array(await entry.async('uint8array'));
    if (bytes.byteLength > budget) {
      parts.push(`${entry.name}: NOT ATTACHED, archive byte budget exhausted.`);
      continue;
    }
    budget -= bytes.byteLength;
    const inner = await prepareFile({ id: `${file.id}/${entry.name}`, name: entry.name, mime: '', bytes }, `${role} (inside ${file.name})`, 1);
    parts.push(...inner.parts);
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) parts.push(`${entries.length - MAX_ARCHIVE_ENTRIES} further file(s) in the archive were not attached (limit ${MAX_ARCHIVE_ENTRIES}).`);
  return { ...base, delivery: 'archive', parts };
}

/* ─────────────────────────────────────────────── helpers ── */

const mb = (n: number) => Math.round(n / 1_048_576);
const clip = (text: string) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated at ${MAX_TEXT_CHARS} chars)` : text);
