import JSZip from 'jszip';
import { imageSize } from './fileFacts';
import { nsAttr, nsInners, nsTexts } from './xmlTags';

/**
 * Deterministic facts and text pulled straight from OOXML packages.
 * No rendering, no model: whatever is stated here is true of the file.
 */

export type OfficeKind = 'pptx' | 'docx' | 'xlsx';
export type OfficePreviewKind = OfficeKind | 'ppt' | 'doc' | 'xls';

const OFFICE_EXT: Record<string, OfficePreviewKind> = {
  pptx: 'pptx',
  ppt: 'ppt',
  docx: 'docx',
  doc: 'doc',
  xlsx: 'xlsx',
  xls: 'xls',
};
const OFFICE_MIME: Record<string, OfficePreviewKind> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
};

const EMBEDDED_IMAGE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** ElementTree / some Python writers emit ns0: instead of p:/r:/a:. Impress will not open that. */
const OFFICE_NS_PREFIX: Record<string, string | null> = {
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': null,
  'http://schemas.openxmlformats.org/package/2006/content-types': null,
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties': null,
  'http://schemas.openxmlformats.org/package/2006/core-properties': 'cp',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
};

/** Rewrite ns0-style prefixes to the prefixes LibreOffice and PowerPoint expect. */
export function rewriteOfficeXml(xml: string): string {
  const mapping = new Map<string, string | null>();
  for (const match of xml.matchAll(/xmlns:([A-Za-z0-9]+)="([^"]+)"/g)) {
    const prefix = match[1]!;
    const uri = match[2]!;
    if (prefix.startsWith('ns') && uri in OFFICE_NS_PREFIX) mapping.set(prefix, OFFICE_NS_PREFIX[uri] ?? null);
  }
  if (mapping.size === 0) return xml;
  let out = xml;
  for (const old of [...mapping.keys()].toSorted((a, b) => b.length - a.length)) {
    const next = mapping.get(old);
    if (!next) {
      out = out.replaceAll(`xmlns:${old}=`, 'xmlns=');
      out = out.replace(new RegExp(`(</?)${old}:`, 'g'), '$1');
      out = out.replace(new RegExp(`(?<=\\s)${old}:`, 'g'), '');
    } else {
      out = out.replaceAll(`xmlns:${old}=`, `xmlns:${next}=`);
      out = out.replace(new RegExp(`(</?)${old}:`, 'g'), `$1${next}:`);
      out = out.replace(new RegExp(`(?<=\\s)${old}:`, 'g'), `${next}:`);
    }
  }
  return out;
}

/** Copy of the package with XML prefixes repaired so Impress can load it. Media bytes stay as-is. */
export async function officeBytesForRender(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const out = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const data = await entry.async('uint8array');
    if (/\.(xml|rels)$/i.test(name)) {
      out.file(name, rewriteOfficeXml(new TextDecoder('utf-8', { fatal: false }).decode(data)));
    } else {
      out.file(name, data);
    }
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const MAX_EMBEDDED_IMAGES = 24;
const MIN_EMBEDDED_BYTES = 64;
const MAX_EMBEDDED_BYTES = 12 * 1024 * 1024;

/** Raster images packed in the OOXML media folder — fallback when LibreOffice cannot render. */
export async function officeEmbeddedImages(bytes: Uint8Array, kind: OfficeKind): Promise<{ name: string; mime: string; bytes: Uint8Array }[]> {
  const zip = await JSZip.loadAsync(bytes);
  const prefix = kind === 'pptx' ? 'ppt/media/' : kind === 'docx' ? 'word/media/' : 'xl/media/';
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n]?.dir && n.replace(/\\/g, '/').startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
  const out: { name: string; mime: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    const mime = EMBEDDED_IMAGE[ext];
    if (!mime) continue;
    const data = new Uint8Array(await zip.files[name]!.async('uint8array'));
    if (data.byteLength < MIN_EMBEDDED_BYTES || data.byteLength > MAX_EMBEDDED_BYTES) continue;
    out.push({ name: name.split('/').pop() ?? name, mime, bytes: data });
    if (out.length >= MAX_EMBEDDED_IMAGES) break;
  }
  return out;
}

export function officePreviewKind(name: string, mime: string): OfficePreviewKind | null {
  const ext = name.toLowerCase().match(/\.(pptx?|docx?|xlsx?)$/)?.[1];
  if (ext && OFFICE_EXT[ext]) return OFFICE_EXT[ext]!;
  return OFFICE_MIME[mime.toLowerCase().split(';')[0]?.trim() ?? ''] ?? null;
}

const MAX_DIGEST_CHARS = 40_000;

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function texts(xml: string, tag: RegExp): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(tag)) {
    const text = decode(match[1] ?? '');
    if (text.trim()) out.push(text);
  }
  return out;
}

const slideNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

async function slidesOf(zip: JSZip): Promise<string[]> {
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

function aspect(cx: number, cy: number): string {
  if (!cx || !cy) return 'unknown';
  const ratio = cx / cy;
  const known: [string, number][] = [['16:9', 16 / 9], ['4:3', 4 / 3], ['16:10', 1.6], ['A4 portrait', 210 / 297], ['A4 landscape', 297 / 210], ['1:1', 1]];
  const match = known.find(([, r]) => Math.abs(r - ratio) < 0.01);
  return match ? match[0] : ratio.toFixed(3);
}

function fontsIn(xml: string): string[] {
  return [...new Set([...xml.matchAll(/typeface="([^"]+)"/g)].map((m) => m[1] ?? '').filter((f) => f && !f.startsWith('+')))];
}

/** Human-readable fact sheet, one fact per line. */
export async function officeManifest(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const lines: string[] = [];
  const media = Object.keys(zip.files).filter((n) => /\/media\//.test(n) && !zip.files[n]?.dir);
  const videos = media.filter((n) => /\.(mp4|mov|m4v|webm|avi|wmv)$/i.test(n));
  const audios = media.filter((n) => /\.(mp3|wav|m4a|aac|wma)$/i.test(n));
  const images = media.length - videos.length - audios.length;

  if (kind === 'pptx') {
    const slides = await slidesOf(zip);
    const presentation = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
    const size = presentation.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    const cx = Number(size?.[1] ?? 0);
    const cy = Number(size?.[2] ?? 0);
    lines.push(`Kind: PowerPoint deck (.pptx)`);
    lines.push(`Slides: ${slides.length}`);
    if (cx && cy) lines.push(`Slide size: ${(cx / 914400).toFixed(2)} x ${(cy / 914400).toFixed(2)} in, aspect ${aspect(cx, cy)}`);
    let hidden = 0;
    let withNotes = 0;
    let withPictures = 0;
    let charts = 0;
    let tables = 0;
    let transitions = 0;
    let animations = 0;
    const fonts = new Set<string>();
    const titles: string[] = [];
    for (const [index, name] of slides.entries()) {
      const xml = await zip.file(name)!.async('string');
      if (/<p:sld[^>]*\sshow="0"/.test(xml)) hidden += 1;
      if (/<p:pic\b/.test(xml)) withPictures += 1;
      charts += (xml.match(/<c:chart\b/g) ?? []).length;
      tables += (xml.match(/<a:tbl\b/g) ?? []).length;
      if (/<p:transition\b/.test(xml)) transitions += 1;
      if (/<p:timing\b/.test(xml)) animations += 1;
      for (const f of fontsIn(xml)) fonts.add(f);
      const title = xml.match(/<p:ph[^>]*type="(?:ctrTitle|title)"[\s\S]*?<\/p:sp>/)?.[0];
      const titleText = title ? texts(title, /<a:t[^>]*>([^<]*)<\/a:t>/g).join(' ').trim() : '';
      titles.push(`  ${index + 1}. ${titleText || '(no title placeholder)'}`);
      const notes = zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`);
      if (notes && texts(await notes.async('string'), /<a:t[^>]*>([^<]*)<\/a:t>/g).join('').trim()) withNotes += 1;
    }
    lines.push(`Hidden slides: ${hidden}`);
    lines.push(`Slides with speaker notes: ${withNotes}`);
    lines.push(`Slides with pictures: ${withPictures}; embedded images: ${images}; videos: ${videos.length}; audio: ${audios.length}`);
    lines.push(`Charts: ${charts}; tables: ${tables}`);
    lines.push(`Slides with transitions: ${transitions}; slides with animations: ${animations}`);
    const themeFonts = fontsIn((await zip.file('ppt/theme/theme1.xml')?.async('string')) ?? '');
    if (themeFonts.length) lines.push(`Theme fonts: ${themeFonts.join(', ')}`);
    if (fonts.size) lines.push(`Fonts used on slides: ${[...fonts].sort().join(', ')}`);
    lines.push('Slide titles:', ...titles);
    const pictures = await picturesOf(zip, slides);
    if (pictures.length) {
      lines.push('Pictures (skew outside 0.97-1.03 = stretched; stills may crop instead of stretch):', ...pictures);
    }
    return lines.join('\n');
  }

  if (kind === 'docx') {
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const paragraphs = document.split(/<\/w:p>/).map((p) => texts(p, /<w:t[^>]*>([^<]*)<\/w:t>/g).join('')).filter((p) => p.trim());
    const words = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
    const headings = (document.match(/<w:pStyle w:val="Heading\d"/g) ?? []).length;
    const pageSize = document.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/);
    const pages = (document.match(/<w:br w:type="page"\/>/g) ?? []).length + 1;
    lines.push('Kind: Word document (.docx)');
    lines.push(`Paragraphs: ${paragraphs.length}; words (approx.): ${words}; headings: ${headings}`);
    lines.push(`Explicit page breaks: ${pages - 1} (so at least ${pages} page(s))`);
    if (pageSize) lines.push(`Page size: ${(Number(pageSize[1]) / 1440).toFixed(2)} x ${(Number(pageSize[2]) / 1440).toFixed(2)} in`);
    lines.push(`Embedded images: ${images}; tables: ${(document.match(/<w:tbl>/g) ?? []).length}`);
    const fonts = fontsIn(document.replace(/w:ascii="/g, 'typeface="'));
    if (fonts.length) lines.push(`Fonts referenced: ${fonts.join(', ')}`);
    return lines.join('\n');
  }

  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const sheetNames = nsInners(workbook, 'sheet').map((s) => decode(nsAttr(s.attrs, 'name') ?? '')).filter(Boolean);
  lines.push('Kind: Excel workbook (.xlsx)');
  lines.push(`Sheets (${sheetNames.length}): ${sheetNames.join(', ')}`);
  lines.push(`Charts: ${Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)).length}; embedded images: ${images}`);
  return lines.join('\n');
}

/** Full text content, in reading order, for grading content without a render. */
export async function officeTextDigest(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const lines: string[] = [];

  if (kind === 'pptx') {
    const slides = await slidesOf(zip);
    for (const [index, name] of slides.entries()) {
      const xml = await zip.file(name)!.async('string');
      lines.push(`\n[Slide ${index + 1}]`);
      lines.push(...xml.split(/<\/a:p>/).map((p) => texts(p, /<a:t[^>]*>([^<]*)<\/a:t>/g).join('')).filter((p) => p.trim()));
      const notes = zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`);
      if (notes) {
        const noteText = texts(await notes.async('string'), /<a:t[^>]*>([^<]*)<\/a:t>/g).join(' ').trim();
        if (noteText) lines.push(`[Speaker notes] ${noteText}`);
      }
    }
  } else if (kind === 'docx') {
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
    lines.push(...xml.split(/<\/w:p>/).map((p) => texts(p, /<w:t[^>]*>([^<]*)<\/w:t>/g).join('')).filter((p) => p.trim()));
  } else {
    const shared = nsTexts((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '', 't');
    const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
    const names = nsInners(workbook, 'sheet').map((s) => decode(nsAttr(s.attrs, 'name') ?? '')).filter(Boolean);
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
    for (const [index, name] of sheets.entries()) {
      const xml = await zip.file(name)!.async('string');
      lines.push(`\n[Sheet: ${names[index] ?? name}]`);
      for (const row of nsInners(xml, 'row')) {
        const cells = nsInners(row.inner, 'c').map((c) => xlsxCell(c.attrs, c.inner, shared));
        if (cells.some((c) => c.trim())) lines.push(cells.join('\t'));
      }
    }
  }

  const text = lines.join('\n').trim();
  return text.length > MAX_DIGEST_CHARS ? `${text.slice(0, MAX_DIGEST_CHARS)}\n…(digest truncated)` : text;
}

const EMU_PER_INCH = 914400;
const SKEW_OK_MIN = 0.97;
const SKEW_OK_MAX = 1.03;
const MAX_PICTURE_FACTS = 40;

function ratioLabel(width: number, height: number): string {
  if (!width || !height) return 'unknown';
  return `${(width / height).toFixed(2)}:1`;
}

function relTargetName(target: string): string {
  const path = decode(target).replace(/\\/g, '/');
  return path.split('/').pop() ?? path;
}

function cropOf(xml: string): { kind: 'srcRect' | 'fillRect'; l: number; t: number; r: number; b: number } | null {
  const src = nsInners(xml, 'srcRect')[0];
  if (src) {
    return {
      kind: 'srcRect',
      l: Number(nsAttr(src.attrs, 'l') ?? 0),
      t: Number(nsAttr(src.attrs, 't') ?? 0),
      r: Number(nsAttr(src.attrs, 'r') ?? 0),
      b: Number(nsAttr(src.attrs, 'b') ?? 0),
    };
  }
  const fill = nsInners(xml, 'fillRect')[0];
  if (!fill) return null;
  const l = Number(nsAttr(fill.attrs, 'l') ?? 0);
  const t = Number(nsAttr(fill.attrs, 't') ?? 0);
  const r = Number(nsAttr(fill.attrs, 'r') ?? 0);
  const b = Number(nsAttr(fill.attrs, 'b') ?? 0);
  if (!l && !t && !r && !b) return null;
  return { kind: 'fillRect', l, t, r, b };
}

async function picturesOf(zip: JSZip, slides: string[]): Promise<string[]> {
  const lines: string[] = [];
  const sizeByMedia = new Map<string, { width: number; height: number } | null>();
  for (const [index, name] of slides.entries()) {
    if (lines.length >= MAX_PICTURE_FACTS) break;
    const xml = await zip.file(name)!.async('string');
    const relsPath = name.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels');
    const rels = new Map<string, string>();
    for (const rel of nsInners((await zip.file(relsPath)?.async('string')) ?? '', 'Relationship')) {
      const id = nsAttr(rel.attrs, 'Id');
      const target = nsAttr(rel.attrs, 'Target');
      if (id && target) rels.set(id, relTargetName(target));
    }
    for (const pic of nsInners(xml, 'pic')) {
      if (lines.length >= MAX_PICTURE_FACTS) break;
      if (!pic.inner) continue;
      const xfrm = nsInners(pic.inner, 'xfrm')[0];
      const ext = xfrm ? nsInners(xfrm.inner, 'ext')[0] : undefined;
      const cx = Number(nsAttr(ext?.attrs ?? '', 'cx') ?? 0);
      const cy = Number(nsAttr(ext?.attrs ?? '', 'cy') ?? 0);
      if (!cx || !cy) continue;
      const embed = nsAttr(nsInners(pic.inner, 'blip')[0]?.attrs ?? '', 'embed');
      const mediaName = embed ? rels.get(embed) : undefined;
      if (!mediaName) continue;
      if (!sizeByMedia.has(mediaName)) {
        const mediaPath = Object.keys(zip.files).find((n) => n.replace(/\\/g, '/').endsWith(`/media/${mediaName}`));
        const bytes = mediaPath ? new Uint8Array(await zip.files[mediaPath]!.async('uint8array')) : null;
        sizeByMedia.set(mediaName, bytes ? imageSize(bytes) : null);
      }
      const size = sizeByMedia.get(mediaName) ?? null;
      const crop = cropOf(pic.inner);
      const placedW = cx / EMU_PER_INCH;
      const placedH = cy / EMU_PER_INCH;
      if (!size) {
        lines.push(
          `  Slide ${index + 1} ${mediaName}: native unverified, placed ${placedW.toFixed(2)}x${placedH.toFixed(2)} in (${ratioLabel(cx, cy)}), crop ${crop?.kind ?? 'none'}, skew unverified`,
        );
        continue;
      }
      let nativeW = size.width;
      let nativeH = size.height;
      let destW = cx;
      let destH = cy;
      if (crop?.kind === 'srcRect') {
        nativeW = size.width * (1 - crop.l / 100_000 - crop.r / 100_000);
        nativeH = size.height * (1 - crop.t / 100_000 - crop.b / 100_000);
      } else if (crop?.kind === 'fillRect') {
        destW = cx * (1 - crop.l / 100_000 - crop.r / 100_000);
        destH = cy * (1 - crop.t / 100_000 - crop.b / 100_000);
      }
      if (!nativeW || !nativeH || !destW || !destH) {
        lines.push(
          `  Slide ${index + 1} ${mediaName}: native ${size.width}x${size.height} (${ratioLabel(size.width, size.height)}), placed ${placedW.toFixed(2)}x${placedH.toFixed(2)} in (${ratioLabel(cx, cy)}), crop ${crop?.kind ?? 'none'}, skew unverified`,
        );
        continue;
      }
      const skew = destW / destH / (nativeW / nativeH);
      const verdict = skew >= SKEW_OK_MIN && skew <= SKEW_OK_MAX ? 'ok' : 'stretched';
      lines.push(
        `  Slide ${index + 1} ${mediaName}: native ${size.width}x${size.height} (${ratioLabel(size.width, size.height)}), placed ${placedW.toFixed(2)}x${placedH.toFixed(2)} in (${ratioLabel(cx, cy)}), crop ${crop?.kind ?? 'none'}, skew ${skew.toFixed(2)}, ${verdict}`,
      );
    }
  }
  return lines;
}

function xlsxCell(attrs: string, inner: string, shared: string[]): string {
  const type = nsAttr(attrs, 't') ?? '';
  const value = nsTexts(inner, 'v').join('') || nsTexts(inner, 't').join('');
  if (type === 's') return shared[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return value;
}
