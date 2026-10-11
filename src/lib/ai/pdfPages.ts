import 'server-only';

import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** One rendered page of an Office PDF (a slide, a Word page, a sheet). */
export interface RenderedPage {
  index: number;
  mime: 'image/jpeg';
  bytes: Uint8Array;
}

export const MAX_RENDERED_PAGES = 40;
const TARGET_WIDTH = 1280;

/**
 * Turns each PDF page into a JPEG the autorater can inspect.
 * Used after LibreOffice converts PPTX/DOCX/XLSX so visual seats see the slide, not just text.
 */
export async function rasterizePdfPages(pdf: Uint8Array): Promise<RenderedPage[]> {
  const doc = await getDocument({ data: Uint8Array.from(pdf), verbosity: 0, useSystemFonts: true }).promise;
  try {
    const count = Math.min(doc.numPages, MAX_RENDERED_PAGES);
    const pages: RenderedPage[] = [];
    for (let index = 1; index <= count; index += 1) {
      const page = await doc.getPage(index);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, TARGET_WIDTH / Math.max(1, base.width));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as never, viewport, canvas: canvas as never }).promise;
      pages.push({ index, mime: 'image/jpeg', bytes: new Uint8Array(canvas.toBuffer('image/jpeg', 72)) });
    }
    return pages;
  } finally {
    await doc.cleanup();
  }
}
