import { describe, expect, it } from 'vitest';
import { rasterizePdfPages } from '@/lib/ai/pdfPages';

function onePagePdf(): Uint8Array {
  const stream = '0.2 0.5 0.8 rg 20 20 260 160 re f\n';
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R>>endobj\n',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}endstream\nendobj\n`,
  ];
  let body = '%PDF-1.4\n';
  const xref = [0];
  for (const obj of objs) {
    xref.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  let table = `xref\n0 5\n0000000000 65535 f \n`;
  for (const off of xref.slice(1)) table += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `${table}trailer<</Size 5/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('rasterizePdfPages', () => {
  it('turns each PDF page into a JPEG still', async () => {
    const pages = await rasterizePdfPages(onePagePdf());
    expect(pages).toHaveLength(1);
    expect(pages[0]?.index).toBe(1);
    expect(pages[0]?.mime).toBe('image/jpeg');
    expect(pages[0]?.bytes.byteLength).toBeGreaterThan(200);
    expect(pages[0]?.bytes[0]).toBe(0xff);
    expect(pages[0]?.bytes[1]).toBe(0xd8);
  });
});
