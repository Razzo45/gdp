import 'server-only';

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import JSZip from 'jszip';
import { db } from '@/db/client';
import { derivatives, fileFacts } from '@/db/schema';
import { sha256 } from '@/domain/fingerprint';
import { canReuseStagedUri } from '@/domain/jobs';
import { env } from '@/lib/env';
import { getObject, putObject } from '@/lib/storage';
import { describeFileFacts, describeFileFactsAsync, factsCurrent, factsFullyMeasured } from './fileFacts';
import { mediaPart, SEND_TEXT_CHARS, type MediaPart } from './gemini';
import { officeBytesForRender, officeEmbeddedImages, officeManifest, officePreviewKind, officeTextDigest, type OfficeKind, type OfficePreviewKind } from './office';
import { DESKTOP, MAX_PAGE_HEIGHT, MOBILE, screenshotHtml, type HtmlShot } from './htmlShots';
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

/** Rebuild a prepared native file from a live Files API handle — no bytes, no upload. `facts` must be the stored measured facts. */
export function preparedFromUri(input: { id: string; name: string; mime: string; sha256: string; size: number; uri: string; role: string; facts: string }): PreparedFile {
  const label = `${input.role}: ${input.name} (id ${input.id})`;
  return {
    id: input.id,
    name: input.name,
    sha256: input.sha256,
    bytes: input.size,
    delivery: 'native',
    parts: [`${label}\n${input.facts}`, { kind: 'uri', mime: input.mime, data: input.uri, label }],
  };
}

/** Measured FILE FACTS from an earlier prepareFile of the same bytes, or null if they must be re-measured. */
export async function storedFileFacts(digest: string): Promise<string | null> {
  try {
    const row = (await db().select({ facts: fileFacts.facts }).from(fileFacts).where(eq(fileFacts.sha256, digest)).limit(1))[0];
    return row?.facts && factsCurrent(row.facts) ? row.facts : null;
  } catch {
    return null;
  }
}

async function rememberFileFacts(digest: string, facts: string): Promise<void> {
  if (!factsFullyMeasured(facts)) return;
  try {
    await db().insert(fileFacts).values({ sha256: digest, facts }).onConflictDoUpdate({ target: fileFacts.sha256, set: { facts } });
  } catch {
    /* cache only — a miss makes the next re-run read the bytes again */
  }
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT_CHARS = 40_000;
/** Soft cap on total unpacked archive payload. No per-entry count limit — site zips often put HTML/JS after dozens of assets alphabetically. */
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

const NATIVE_MIME = /^(image\/(png|jpe?g|webp|heic|heif|gif)|video\/|audio\/|application\/pdf|text\/)/;
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', json: 'text/plain', srt: 'text/plain',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  zip: 'application/zip',
};

const ZIP_MIME = /^(application\/(zip|x-zip-compressed|x-zip)|multipart\/x-zip)$/;
const FONT_MIME = /^(font\/|application\/(font-woff2?|vnd\.ms-fontobject|x-font-))/;

/** Trust the bytes when a JPEG/PNG/PDF is wearing an Office name. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 3) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.byteLength >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function normaliseMime(name: string, mime: string, bytes?: Uint8Array): string {
  const sniffed = bytes ? sniffMime(bytes) : null;
  if (sniffed) return sniffed;
  const clean = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (clean && clean !== 'application/octet-stream' && clean !== 'binary/octet-stream') return clean;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXT_MIME[ext] || 'application/octet-stream';
}

export async function prepareFile(file: SourceFile, role: string, depth = 0, siblings: { name: string; bytes: Uint8Array }[] = []): Promise<PreparedFile> {
  const digest = sha256(file.bytes);
  const mime = normaliseMime(file.name, file.mime, file.bytes);
  const label = `${role}: ${file.name} (id ${file.id})`;
  const base = { id: file.id, name: file.name, sha256: digest, bytes: file.bytes.byteLength };

  if (file.bytes.byteLength === 0) {
    return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: the file is empty.`] };
  }
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: file is ${mb(file.bytes.byteLength)} MB, above the ${mb(MAX_FILE_BYTES)} MB grading limit.`] };
  }

  const facts = await describeFileFactsAsync({ name: file.name, mime, size: file.bytes.byteLength, bytes: file.bytes });
  if (canReuseStagedUri(mime, file.name)) await rememberFileFacts(digest, facts);

  if (mime === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const text = Buffer.from(file.bytes).toString('utf8');
    if (text.length > SEND_TEXT_CHARS) {
      return {
        ...base,
        delivery: 'native',
        parts: [
          `${label}\n${facts}\nSVG attached in full (${text.length} chars). Inspect the attached file, not a clipped digest.`,
          await mediaPart({ bytes: file.bytes, mime: 'image/svg+xml', sha256: digest, name: file.name, label }),
        ],
      };
    }
    return { ...base, delivery: 'text_digest', parts: [`${label}\n${facts}\nSVG markup (not rasterised):\n${text}\n--- end ---`] };
  }

  if (NATIVE_MIME.test(mime) || /^(application\/(javascript|x-javascript|json))$/.test(mime)) {
    if (mime.startsWith('text/') || /javascript|\/json$/.test(mime)) {
      const text = Buffer.from(file.bytes).toString('utf8');
      const html = mime === 'text/html' || /\.html?$/i.test(file.name);
      // Long text (especially HTML prototypes) must not go in the prompt
      // string. tightenSendParts clips every string to 12k, which cut this
      // task's 84k HTML at the Categories label and made raters invent
      // incomplete_generation. Attach the file like a PDF instead.
      if (html) {
        const shots = await htmlScreenshots(file, digest, siblings).catch(() => []);
        const shotParts = await Promise.all(
          shots.map((shot) =>
            mediaPart({
              bytes: shot.bytes,
              mime: shot.mime,
              sha256: sha256(shot.bytes),
              name: `${file.name.replace(/\.[a-z0-9]+$/i, '')}-${shot.view}.jpg`,
              label: `${label} — ${shot.view === 'desktop' ? `desktop screenshot, ${DESKTOP.width}px wide` : `phone screenshot, ${MOBILE.width}px wide`}`,
            }),
          ),
        );
        const renderNote = shots.length
          ? `The page was opened in a browser and screenshotted (${shots.map((shot) => (shot.view === 'desktop' ? `desktop ${DESKTOP.width}px wide, full page up to ${MAX_PAGE_HEIGHT}px tall` : `phone ${MOBILE.width}px wide, first screen`)).join('; ')}). Judge layout, colour, typography, imagery and anything drawn by scripts (canvas, WebGL, three.js) from the screenshots; judge text and structure from the source. States reached only by clicking, hovering or later animation are not in the screenshots; check the source for them.`
          : 'The page could not be rendered in a browser. Judge visual statements from the source only where the markup states them explicitly.';
        return {
          ...base,
          delivery: 'native',
          parts: [
            `${label}\n${facts}\nHTML attached in full (${text.length} chars). Inspect the attached file, not a clipped digest.\n${renderNote}`,
            await mediaPart({ bytes: file.bytes, mime, sha256: digest, name: file.name, label }),
            ...shotParts,
          ],
        };
      }
      if (text.length > SEND_TEXT_CHARS) {
        return {
          ...base,
          delivery: 'native',
          parts: [
            `${label}\n${facts}\nText attached in full (${text.length} chars). Inspect the attached file, not a clipped digest.`,
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

  if (ZIP_MIME.test(mime) || /\.zip$/i.test(file.name)) {
    if (depth > 0) return { ...base, delivery: 'unsupported', parts: [`${label}\nNOT ATTACHED: nested archives are not expanded.`] };
    return prepareArchive(file, role, label, base);
  }

  if (FONT_MIME.test(mime) || /\.(woff2?|ttf|otf|eot)$/i.test(file.name)) {
    return {
      ...base,
      delivery: 'text_digest',
      parts: [`${label}\n${facts}\nFont file present in the archive. Judge whether it is used from the HTML/CSS and the screenshots; do not answer No only because the font bytes were not attached.`],
    };
  }

  return {
    ...base,
    delivery: 'unsupported',
    parts: [
      depth > 0
        ? `${label}\nPresent in the archive (${mime}). Not a format the grader reads as its own file; use the archive listing, HTML/CSS and screenshots.`
        : `${label}\nNOT ATTACHED: ${mime} is not a format the grader can read. Statements that depend on its content must be answered No, with that reason as evidence.`,
    ],
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
  const digest = text ? `\n--- text digest ---\n${clip(text, 2_000)}\n--- end ---` : '';

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
          `${label}${facts}\nThe deliverable is a ${kind.toUpperCase()} file. The ${pages.length} JPEG image(s) below are rendered ${unit} stills of that file — they are not the deliverable format. FILE FACTS decide kind, ${unit} count and packaged size. Inspect each still for layout, colour, typography and photographs. Animations, transitions and embedded video are not in the stills.${extra}${digest}`,
          ...pageParts,
          await mediaPart({ bytes: pdf, mime: 'application/pdf', sha256: sha256(pdf), name: file.name.replace(/\.[a-z0-9]+$/i, '.pdf'), label: `${label} — PDF render of the ${kind.toUpperCase()}` }),
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
const HTML_SHOT_TOOL = 'chromium-shot-v1';

/** Desktop and phone screenshots of an HTML deliverable, taken at most once per content (page plus archive siblings). */
async function htmlScreenshots(file: SourceFile, digest: string, siblings: { name: string; bytes: Uint8Array }[]): Promise<HtmlShot[]> {
  const key = siblings.length ? sha256([digest, ...siblings.map((row) => `${row.name}:${sha256(row.bytes)}`).sort()].join('\n')) : digest;
  const database = db();
  const views = ['desktop', 'mobile'] as const;
  const cached = await database.select().from(derivatives).where(and(eq(derivatives.sourceSha256, key), inArray(derivatives.kind, views.map((view) => `html-${view}`))));
  if (cached.length > 0) {
    const stored = await Promise.all(
      cached.map(async (row) => {
        const bytes = await getObject(row.storagePath);
        return bytes && sha256(bytes) === row.sha256 ? { view: row.kind.replace('html-', '') as HtmlShot['view'], mime: 'image/jpeg' as const, bytes } : null;
      }),
    );
    const usable = stored.filter((shot): shot is HtmlShot => shot !== null);
    if (usable.length === cached.length) return views.flatMap((view) => usable.filter((shot) => shot.view === view));
  }

  const shots = await screenshotHtml({ name: file.name, bytes: file.bytes, siblings });
  for (const shot of shots) {
    const path = `derivatives/${key}-${shot.view}.jpg`;
    await putObject(path, shot.bytes, shot.mime);
    const row = { storagePath: path, mime: shot.mime, size: shot.bytes.byteLength, sha256: sha256(shot.bytes), tool: HTML_SHOT_TOOL };
    await database
      .insert(derivatives)
      .values({ sourceSha256: key, kind: `html-${shot.view}`, ...row })
      .onConflictDoUpdate({ target: [derivatives.sourceSha256, derivatives.kind], set: row });
  }
  return shots;
}

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
    const renderBytes = isOoxml(kind) ? await officeBytesForRender(bytes).catch(() => bytes) : bytes;
    await writeFile(input, renderBytes);
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
  const loaded: { name: string; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.async('uint8array'));
    if (bytes.byteLength > budget) {
      parts.push(`${entry.name}: NOT ATTACHED, archive byte budget exhausted.`);
      continue;
    }
    budget -= bytes.byteLength;
    loaded.push({ name: entry.name, bytes });
  }
  for (const entry of loaded) {
    const siblings = /\.html?$/i.test(entry.name) ? loaded.filter((row) => row !== entry) : [];
    const inner = await prepareFile({ id: `${file.id}/${entry.name}`, name: entry.name, mime: '', bytes: entry.bytes }, `${role} (inside ${file.name})`, 1, siblings);
    parts.push(...inner.parts);
  }
  return { ...base, delivery: 'archive', parts };
}

/* ─────────────────────────────────────────────── helpers ── */

const mb = (n: number) => Math.round(n / 1_048_576);
const clip = (text: string, limit = MAX_TEXT_CHARS) => (text.length > limit ? `${text.slice(0, limit)}\n…(truncated at ${limit} chars)` : text);
