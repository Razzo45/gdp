import JSZip from 'jszip';

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
  const sheetNames = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => decode(m[1] ?? ''));
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
    const shared = texts((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '', /<t[^>]*>([^<]*)<\/t>/g);
    const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
    const names = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => decode(m[1] ?? ''));
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
    for (const [index, name] of sheets.entries()) {
      const xml = await zip.file(name)!.async('string');
      lines.push(`\n[Sheet: ${names[index] ?? name}]`);
      for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [...(row[1] ?? '').matchAll(/<c([^>]*)>(?:<f>[^<]*<\/f>)?<v>([^<]*)<\/v>/g)].map((c) => (/t="s"/.test(c[1] ?? '') ? (shared[Number(c[2])] ?? '') : (c[2] ?? '')));
        if (cells.some((c) => c.trim())) lines.push(cells.join('\t'));
      }
    }
  }

  const text = lines.join('\n').trim();
  return text.length > MAX_DIGEST_CHARS ? `${text.slice(0, MAX_DIGEST_CHARS)}\n…(digest truncated)` : text;
}
