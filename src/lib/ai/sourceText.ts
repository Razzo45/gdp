import 'server-only';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { SourceFile } from './media';
import { officePreviewKind, officeTextDigest } from './office';

const MAX_PDF_PAGES = 80;
const TEXT_NAME = /\.(txt|md|csv|tsv|html?|json)$/i;

/** Names of task inputs worth downloading for their text. Media is skipped. */
export function hasReadableText(name: string, mime: string): boolean {
  const office = officePreviewKind(name, mime);
  return office === 'docx' || office === 'pptx' || office === 'xlsx' || /\.pdf$/i.test(name) || mime === 'application/pdf' || TEXT_NAME.test(name) || mime.startsWith('text/');
}

/** Plain text of a task input, so a cited source line can be checked against it. */
export async function sourceFileText(file: SourceFile): Promise<string> {
  const office = officePreviewKind(file.name, file.mime);
  if (office === 'docx' || office === 'pptx' || office === 'xlsx') return officeTextDigest(file.bytes, office).catch(() => '');
  if (/\.pdf$/i.test(file.name) || file.mime === 'application/pdf') return pdfText(file.bytes).catch(() => '');
  if (TEXT_NAME.test(file.name) || file.mime.startsWith('text/')) return new TextDecoder('utf-8', { fatal: false }).decode(file.bytes);
  return '';
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: Uint8Array.from(bytes), verbosity: 0, useSystemFonts: true }).promise;
  try {
    const pages: string[] = [];
    for (let index = 1; index <= Math.min(doc.numPages, MAX_PDF_PAGES); index += 1) {
      const content = await (await doc.getPage(index)).getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    return pages.join('\n');
  } finally {
    await doc.cleanup();
  }
}
