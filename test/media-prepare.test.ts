import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { SEND_TEXT_CHARS, tightenSendParts } from '@/lib/ai/gemini';
import { officeEmbeddedImages } from '@/lib/ai/office';
import { prepareFile } from '@/lib/ai/media';

vi.mock('@/lib/ai/gemini', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/gemini')>();
  return {
    ...real,
    mediaPart: async (input: { bytes?: Uint8Array; mime: string; sha256: string; name: string; label: string; stage?: boolean }) => {
      if (input.stage) return { kind: 'uri' as const, mime: input.mime, data: `files/${input.sha256}`, label: input.label };
      return real.mediaPart(input);
    },
  };
});

describe('prepareFile edge cases', () => {
  it('refuses an empty file instead of sending it as evidence', async () => {
    const prepared = await prepareFile({ id: 'e', name: 'blank.png', mime: 'image/png', bytes: new Uint8Array() }, 'CONSIDERED OUTPUT');
    expect(prepared.delivery).toBe('unsupported');
    expect(prepared.parts.join('')).toMatch(/empty/);
  });

  it('attaches a long CSV the same way so the 12k send clip cannot slice it', async () => {
    const body = `name,score\n${'alpha,1\n'.repeat(2_000)}tail-row,99\n`;
    expect(body.length).toBeGreaterThan(12_000);
    expect(body.length).toBeLessThan(40_000);
    const prepared = await prepareFile({ id: 'c', name: 'scores.csv', mime: 'text/csv', bytes: new TextEncoder().encode(body) }, 'SUBMITTED INPUT');
    const tight = tightenSendParts(prepared.parts);
    const text = tight.filter((part): part is string => typeof part === 'string').join('\n');
    expect(prepared.delivery).toBe('native');
    expect(text).not.toMatch(/truncated at/);
    expect(text).toContain('tail-row,99');
    expect(tight.filter((part) => typeof part === 'string').every((part) => part.length <= SEND_TEXT_CHARS)).toBe(true);
    expect(tight.some((part) => typeof part !== 'string')).toBe(false);
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

  it('keeps the end of a long HTML file in the prompt after the 12k send clip', async () => {
    const marker = 'STATE:VA-ALL-COUNTIES-MARKER';
    const body = `<!DOCTYPE html>\n<html><body>${'<p>card</p>'.repeat(8_000)}<option value="STATE:VA">${marker}</option></body></html>`;
    const bytes = new TextEncoder().encode(body);
    expect(body.length).toBeGreaterThan(40_000);
    const prepared = await prepareFile({ id: 'h', name: 'index.html', mime: 'text/html', bytes }, 'CONSIDERED OUTPUT');
    const tight = tightenSendParts(prepared.parts);
    const text = tight.filter((part): part is string => typeof part === 'string').join('\n');
    expect(prepared.delivery).toBe('native');
    expect(text).toContain(marker);
    expect(text).toContain('<p>card</p>');
    expect(text).not.toMatch(/truncated at/);
    expect(text).toMatch(/no screenshot/i);
    expect(tight.filter((part) => typeof part === 'string').every((part) => part.length <= SEND_TEXT_CHARS)).toBe(true);
    expect(tight.some((part) => typeof part !== 'string' && 'mime' in part && part.mime === 'text/html')).toBe(false);
  });

  it('sends SVG as markup, not as a native image', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect fill="#f00" width="8" height="8"/></svg>');
    const prepared = await prepareFile({ id: 's', name: 'mark.svg', mime: 'image/svg+xml', bytes: svg }, 'CONSIDERED OUTPUT');
    expect(prepared.delivery).toBe('text_digest');
    expect(prepared.parts.join('')).toContain('<svg');
  });

  it('keeps a CSS rule past the 12k clip when the stylesheet lives inside a site zip', async () => {
    const marker = '.btn-primary-blue:hover{transform:none}';
    const css = `${'body{margin:0}'.repeat(2_000)}\n${marker}`;
    expect(css.length).toBeGreaterThan(12_000);
    const zip = new JSZip();
    zip.file('index.html', '<!DOCTYPE html><html><link rel="stylesheet" href="styles.css"></html>');
    zip.file('styles.css', css);
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const prepared = await prepareFile({ id: 'z', name: 'index.zip', mime: 'application/zip', bytes }, 'CONSIDERED OUTPUT');
    const text = tightenSendParts(prepared.parts).filter((part): part is string => typeof part === 'string').join('\n');
    expect(text).toContain(marker);
    expect(text).not.toMatch(/styles\.css[\s\S]{0,200}NOT ATTACHED/);
  });

  it('opens a site zip and attaches the CSS and JS inside so the grader can read them', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<!DOCTYPE html><html><link rel="stylesheet" href="css/style.css"><script src="app.js"></script></html>');
    zip.file('css/style.css', '@media (min-width: 769px) { main { padding: 32px; } }');
    zip.file('app.js', 'document.body.dataset.ready = "1";');
    zip.file('fonts/JakartaSans.woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]));
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const prepared = await prepareFile({ id: 'z', name: 'site.zip', mime: 'application/x-zip-compressed', bytes }, 'CONSIDERED OUTPUT');
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('\n');
    expect(prepared.delivery).toBe('archive');
    expect(text).toContain('@media (min-width: 769px)');
    expect(text).toContain('document.body.dataset.ready');
    expect(tightenSendParts(prepared.parts).filter((part): part is string => typeof part === 'string').join('\n')).toContain('@media (min-width: 769px)');
    expect(text).toContain('JakartaSans.woff2');
    expect(text).not.toMatch(/style\.css[\s\S]{0,200}NOT ATTACHED/);
    expect(text).not.toMatch(/app\.js[\s\S]{0,200}NOT ATTACHED/);
    expect(text).not.toMatch(/JakartaSans[\s\S]{0,200}must be answered No/);
  });

  it('still attaches HTML and JS when a site zip has many assets ahead of them alphabetically', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 30; i++) {
      zip.file(`assets/images/item-${String(i).padStart(2, '0')}.webp`, new Uint8Array([0x52, 0x49, 0x46, 0x46, i, 0, 0, 0]));
    }
    zip.file('index.html', '<!DOCTYPE html><html><body data-menu="stackd"></body></html>');
    zip.file('js/dishes.js', 'export const dishes = [{ name: "Classic Stack" }];');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const prepared = await prepareFile({ id: 'z', name: 'menu.zip', mime: 'application/zip', bytes }, 'CONSIDERED OUTPUT');
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('\n');
    const media = prepared.parts.filter((part) => typeof part !== 'string');
    expect(prepared.delivery).toBe('archive');
    expect(text).toMatch(/index\.html/);
    expect(text).toContain('<body data-menu="stackd"></body>');
    expect(text).toContain('Classic Stack');
    expect(media.some((part) => typeof part !== 'string' && 'mime' in part && part.mime === 'text/html')).toBe(false);
    expect(media.filter((part) => typeof part !== 'string' && 'kind' in part && part.kind === 'inline')).toHaveLength(0);
    expect(text).not.toMatch(/further file\(s\) in the archive were not attached/);
    expect(text).not.toMatch(/index\.html[\s\S]{0,200}NOT ATTACHED/);
    expect(text).not.toMatch(/dishes\.js[\s\S]{0,200}NOT ATTACHED/);
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
