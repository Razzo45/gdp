import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { officeEmbeddedImages } from '@/lib/ai/office';
import { prepareFile } from '@/lib/ai/media';

describe('prepareFile edge cases', () => {
  it('refuses an empty file instead of sending it as evidence', async () => {
    const prepared = await prepareFile({ id: 'e', name: 'blank.png', mime: 'image/png', bytes: new Uint8Array() }, 'CONSIDERED OUTPUT');
    expect(prepared.delivery).toBe('unsupported');
    expect(prepared.parts.join('')).toMatch(/empty/);
  });

  it('attaches a long CSV the same way so the 12k send clip cannot slice it', async () => {
    const body = `name,score\n${'alpha,1\n'.repeat(2_000)}`;
    expect(body.length).toBeGreaterThan(12_000);
    expect(body.length).toBeLessThan(40_000);
    const prepared = await prepareFile({ id: 'c', name: 'scores.csv', mime: 'text/csv', bytes: new TextEncoder().encode(body) }, 'SUBMITTED INPUT');
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('');
    const media = prepared.parts.filter((part) => typeof part !== 'string');
    expect(prepared.delivery).toBe('native');
    expect(text).not.toMatch(/truncated at/);
    expect(text.length).toBeLessThan(4_000);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'inline', mime: 'text/csv' });
  });

  it('attaches a long SVG instead of putting markup in the clipped prompt string', async () => {
    const body = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(800)}</svg>`;
    expect(body.length).toBeGreaterThan(12_000);
    const prepared = await prepareFile({ id: 'v', name: 'mark.svg', mime: 'image/svg+xml', bytes: new TextEncoder().encode(body) }, 'CONSIDERED OUTPUT');
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('');
    const media = prepared.parts.filter((part) => typeof part !== 'string');
    expect(text.length).toBeLessThan(4_000);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'inline', mime: 'image/svg+xml' });
  });

  it('treats JPEG bytes as an image even when the name says PowerPoint', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const prepared = await prepareFile(
      {
        id: 'j',
        name: 'deck.pptx',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: jpeg,
      },
      'CONSIDERED OUTPUT',
    );
    expect(prepared.delivery).toBe('native');
    const media = prepared.parts.filter((part) => typeof part !== 'string');
    expect(media[0]).toMatchObject({ mime: 'image/jpeg' });
  });

  it('attaches a long HTML file in full instead of clipping it to a text digest', async () => {
    const body = `<!DOCTYPE html>\n<html><body>${'<p>card</p>'.repeat(8_000)}</body></html>`;
    const bytes = new TextEncoder().encode(body);
    expect(bytes.byteLength).toBeGreaterThan(40_000);
    const prepared = await prepareFile({ id: 'h', name: 'site.html', mime: 'text/html', bytes }, 'CONSIDERED OUTPUT');
    expect(prepared.delivery).toBe('native');
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('');
    const media = prepared.parts.filter((part) => typeof part !== 'string');
    expect(text).not.toMatch(/truncated at/);
    expect(text.length).toBeLessThan(4_000);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'inline', mime: 'text/html' });
  });

  it('sends SVG as markup, not as a native image', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect fill="#f00" width="8" height="8"/></svg>');
    const prepared = await prepareFile({ id: 's', name: 'mark.svg', mime: 'image/svg+xml', bytes: svg }, 'CONSIDERED OUTPUT');
    expect(prepared.delivery).toBe('text_digest');
    expect(prepared.parts.join('')).toContain('<svg');
  });

  it('pulls embedded photographs out of a PPTX when there is no page render', async () => {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:sld>');
    zip.file('ppt/media/photo.png', png);
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const images = await officeEmbeddedImages(bytes, 'pptx');
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe('photo.png');
    expect(images[0]?.mime).toBe('image/png');
  });
});
