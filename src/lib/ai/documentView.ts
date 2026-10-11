import JSZip from 'jszip';
import { officePreviewKind, officeTextDigest, type OfficeKind } from './office';
import { decodeXml, nsAttr, nsInners, nsTexts } from './xmlTags';

/**
 * Readable HTML for Catalog Office / CSV files without LibreOffice.
 * Pixel layout is not reproduced; text, tables, and embedded raster images are.
 */

export type DocumentViewKind = OfficeKind | 'csv';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 400_000;
const MAX_SHEET_ROWS = 120;
const MAX_SHEET_COLS = 32;

export function documentViewKind(name: string, mime: string): DocumentViewKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'csv' || mime === 'text/csv' || mime === 'application/csv') return 'csv';
  const office = officePreviewKind(name, mime);
  return office === 'pptx' || office === 'docx' || office === 'xlsx' ? office : null;
}

export async function documentViewHtml(bytes: Uint8Array, name: string, mime: string, downloadHref: string): Promise<string> {
  const kind = documentViewKind(name, mime);
  if (!kind) throw new Error('unsupported');
  let body = kind === 'csv' ? csvHtml(bytes) : await officeHtml(bytes, kind);
  const visible = body.replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const structured = /<(p|h[1-4]|td|th|li)\b/i.test(body);
  if (kind !== 'csv' && !structured && visible.length < 80) {
    const digest = await officeTextDigest(bytes, kind);
    if (digest.trim()) body = `<article class="doc"><pre>${escape(digest)}</pre></article>`;
  }
  return page(name, downloadHref, kind, body);
}

async function officeHtml(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  if (kind === 'pptx') return pptxHtml(zip);
  if (kind === 'docx') return docxHtml(zip);
  return xlsxHtml(zip);
}

function csvHtml(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const rows = parseCsv(text).slice(0, MAX_SHEET_ROWS);
  if (rows.length === 0) return `<p class="muted">This CSV is empty.</p>`;
  return `<section class="sheet">${table(rows, true)}</section>`;
}

async function pptxHtml(zip: JSZip): Promise<string> {
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => numberOf(a) - numberOf(b));
  if (slides.length === 0) return `<p class="muted">This deck has no slides.</p>`;
  const parts: string[] = [];
  let images = 0;
  for (const [index, path] of slides.entries()) {
    const xml = (await zip.file(path)?.async('string')) ?? '';
    const rels = await readRels(zip, relsPath(path));
    const title = slideTitle(xml);
    const paras = nsInners(xml, 'p').map((p) => nsTexts(p.inner, 't').join('')).filter((p) => p.trim() && p !== title);
    const pics = await embedImages(zip, xml, rels, 'ppt/slides', images);
    images += pics.count;
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`);
    const notes = notesFile ? nsTexts(await notesFile.async('string'), 't').join(' ').trim() : '';
    parts.push(`<article class="slide">
      <header>Slide ${index + 1}${title ? ` · ${escape(title)}` : ''}</header>
      ${title ? `<h2>${escape(title)}</h2>` : ''}
      ${paras.map((p) => `<p>${escape(p)}</p>`).join('')}
      ${pics.html}
      ${notes ? `<p class="notes">${escape(notes)}</p>` : ''}
    </article>`);
  }
  return parts.join('\n');
}

async function docxHtml(zip: JSZip): Promise<string> {
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  if (!xml) return `<p class="muted">This document has no readable text.</p>`;
  const rels = await readRels(zip, 'word/_rels/document.xml.rels');
  const body = xml.match(/<(?:[A-Za-z_][\w.-]*:)?body\b[^>]*>([\s\S]*)<\/(?:[A-Za-z_][\w.-]*:)?body>/)?.[1] ?? xml;
  const blocks: string[] = [];
  let images = 0;
  for (const match of body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(p|tbl)(?=[\s>/])[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?\1>/g)) {
    const piece = match[0] ?? '';
    if (match[1] === 'tbl') {
      const rows: string[][] = [];
      for (const row of nsInners(piece, 'tr')) {
        const cells = nsInners(row.inner, 'tc').map((c) => nsTexts(c.inner, 't').join(' '));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) blocks.push(table(rows, false));
      continue;
    }
    const text = nsTexts(piece, 't').join('');
    if (text.trim()) {
      const heading = piece.match(/<w:pStyle[^>]*w:val="Heading(\d)"/);
      const level = heading ? Math.min(3, Number(heading[1])) : 0;
      blocks.push(level ? `<h${level + 1}>${escape(text)}</h${level + 1}>` : `<p>${escape(text)}</p>`);
    }
    const pics = await embedImages(zip, piece, rels, 'word', images);
    images += pics.count;
    if (pics.html) blocks.push(pics.html);
  }
  return `<article class="doc">${blocks.join('\n') || '<p class="muted">This document has no readable text.</p>'}</article>`;
}

async function xlsxHtml(zip: JSZip): Promise<string> {
  const shared = nsInners((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '', 'si').map((s) => nsTexts(s.inner, 't').join(''));
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const names = nsInners(workbook, 'sheet').map((s) => decodeXml(nsAttr(s.attrs, 'name') ?? '')).filter(Boolean);
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => numberOf(a) - numberOf(b));
  const parts: string[] = [];
  for (const [index, path] of sheets.entries()) {
    const xml = (await zip.file(path)?.async('string')) ?? '';
    const rows: string[][] = [];
    for (const row of nsInners(xml, 'row')) {
      if (rows.length >= MAX_SHEET_ROWS) break;
      const cells = new Map<number, string>();
      let max = -1;
      for (const cell of nsInners(row.inner, 'c')) {
        const ref = nsAttr(cell.attrs, 'r')?.match(/^([A-Z]+)/);
        const col = ref ? colIndex(ref[1]!) : max + 1;
        if (col >= MAX_SHEET_COLS) continue;
        max = Math.max(max, col);
        cells.set(col, cellValue(cell.attrs, cell.inner, shared));
      }
      if (max < 0) continue;
      const line = Array.from({ length: max + 1 }, (_, i) => cells.get(i) ?? '');
      if (line.some((c) => c.trim())) rows.push(line);
    }
    parts.push(`<section class="sheet"><header>${escape(names[index] || `Sheet ${index + 1}`)}</header>${rows.length ? table(rows, true) : '<p class="muted">Empty sheet.</p>'}</section>`);
  }
  return parts.join('\n') || `<p class="muted">This workbook has no sheets.</p>`;
}

function cellValue(attrs: string, inner: string, shared: string[]): string {
  const type = nsAttr(attrs, 't') ?? '';
  const value = nsTexts(inner, 'v').join('') || nsTexts(inner, 't').join('');
  if (type === 's') return shared[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'inlineStr') return value;
  return formatExcelNumber(value);
}

function formatExcelNumber(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || value.trim() === '') return value;
  if (n > 0 && n < 1) return excelClock(n);
  if (n >= 20_000 && n <= 80_000) {
    const day = Math.floor(n);
    const frac = n - day;
    const date = new Date(Date.UTC(1899, 11, 30) + day * 86_400_000).toISOString().slice(0, 10);
    return frac > 0.0001 ? `${date} ${excelClock(frac)}` : date;
  }
  return value;
}

function excelClock(frac: number): string {
  const mins = Math.round(frac * 24 * 60);
  const hours = Math.floor(mins / 60) % 24;
  const minutes = mins % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function slideTitle(xml: string): string {
  const block = xml.match(/<(?:[A-Za-z_][\w.-]*:)?ph[^>]*type="(?:ctrTitle|title)"[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?sp>/)?.[0];
  return block ? nsTexts(block, 't').join(' ').trim() : '';
}

function numberOf(name: string): number {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function relsPath(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

async function readRels(zip: JSZip, path: string): Promise<Map<string, string>> {
  const xml = (await zip.file(path)?.async('string')) ?? '';
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    map.set(match[1] ?? '', match[2] ?? '');
  }
  return map;
}

async function embedImages(zip: JSZip, xml: string, rels: Map<string, string>, fromDir: string, used: number): Promise<{ html: string; count: number }> {
  const ids = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1] ?? '');
  const html: string[] = [];
  let count = 0;
  for (const id of ids) {
    if (used + count >= MAX_IMAGES) break;
    const target = rels.get(id);
    if (!target || !IMAGE_EXT.test(target)) continue;
    const path = resolveZip(fromDir, target);
    const file = zip.file(path);
    if (!file) continue;
    const data = await file.async('uint8array');
    if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) continue;
    const ext = target.toLowerCase().match(IMAGE_EXT)?.[1]?.replace('jpg', 'jpeg') ?? 'png';
    html.push(`<img src="data:image/${ext};base64,${Buffer.from(data).toString('base64')}" alt=""/>`);
    count += 1;
  }
  return { html: html.join(''), count };
}

function resolveZip(fromDir: string, target: string): string {
  const parts = `${fromDir}/${target}`.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function table(rows: string[][], header: boolean): string {
  const width = Math.max(...rows.map((r) => r.length), 0);
  const cells = (row: string[], tag: 'th' | 'td') =>
    Array.from({ length: width }, (_, i) => `<${tag}>${escape(row[i] ?? '')}</${tag}>`).join('');
  const head = header && rows[0] ? `<thead><tr>${cells(rows[0], 'th')}</tr></thead>` : '';
  const bodyRows = header ? rows.slice(1) : rows;
  const body = `<tbody>${bodyRows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody>`;
  return `<div class="table-wrap"><table>${head}${body}</table></div>`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function page(name: string, downloadHref: string, kind: DocumentViewKind, body: string): string {
  const label = { pptx: 'PowerPoint', docx: 'Word', xlsx: 'Excel', csv: 'CSV' }[kind];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escape(name)}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; background: #fafafa; color: #18181b; font: 16px/1.55 Poppins, ui-sans-serif, system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) { html, body { background: #09090b; color: #fafafa; } .slide, .doc, .sheet { background: #18181b; border-color: #27272a; } th { background: #27272a; } }
    header.bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid #e4e4e7; background: inherit; }
    header.bar strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header.bar span { color: #71717a; font-size: 12px; }
    header.bar a { color: #5d6ae0; font-weight: 600; text-decoration: none; }
    main { padding: 20px; display: grid; gap: 16px; max-width: 1100px; margin: 0 auto; }
    .slide, .doc, .sheet { background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 20px 24px; }
    .slide header, .sheet header { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #71717a; margin-bottom: 8px; }
    h2, h3, h4 { margin: 0 0 8px; }
    p { margin: 0 0 8px; }
    .notes { color: #71717a; font-size: 13px; }
    .muted { color: #71717a; }
    img { max-width: min(100%, 280px); max-height: 140px; width: auto; border-radius: 8px; margin: 8px 0; display: block; }
    .table-wrap { overflow: auto; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #e4e4e7; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f4f4f5; font-weight: 600; }
  </style>
</head>
<body>
  <header class="bar">
    <strong>${escape(name)}</strong>
    <span>${label} · readable view</span>
    <a href="${escape(downloadHref)}">Download</a>
  </header>
  <main>${body}</main>
</body>
</html>`;
}
