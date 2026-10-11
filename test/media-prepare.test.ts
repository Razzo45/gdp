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
