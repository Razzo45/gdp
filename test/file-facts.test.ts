import { describe, expect, it } from 'vitest';
import { describeFileFacts, formatFfprobe } from '@/lib/ai/fileFacts';
import { preparedFromUri } from '@/lib/ai/media';

const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const ONE_PAGE_PDF = new TextEncoder().encode(`%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 3 3] >>endobj
trailer<< /Root 1 0 R >>
%%EOF
`);

describe('describeFileFacts', () => {
  it('always reports the measured file size in MB and exact bytes', () => {
    const facts = describeFileFacts({ name: 'guide.pdf', mime: 'application/pdf', size: 27_670_908 });
    expect(facts).toContain('File size: 26.4 MB (27670908 bytes)');
  });

  it('reads PDF page count, version, encryption and page size from the file bytes', () => {
    const facts = describeFileFacts({ name: 'guide.pdf', mime: 'application/pdf', size: ONE_PAGE_PDF.byteLength, bytes: ONE_PAGE_PDF });
    expect(facts).toContain('Pages: 1');
    expect(facts).toContain('PDF version: 1.1');
    expect(facts).toContain('Encrypted: no');
    expect(facts).toContain('Page size: 3.00 x 3.00 pt, aspect 1:1');
    expect(facts).toContain(`(${ONE_PAGE_PDF.byteLength} bytes)`);
  });

  it('reads PNG pixel dimensions, bit depth and colour type from the header', () => {
    const facts = describeFileFacts({ name: 'dot.png', mime: 'image/png', size: PNG_1X1.byteLength, bytes: PNG_1X1 });
    expect(facts).toMatch(/Dimensions: 1 x 1/);
    expect(facts).toMatch(/Bit depth: \d+/);
    expect(facts).toMatch(/Colour: /);
  });

  it('formats ffprobe colour space, frames, bitrate and audio streams when present', () => {
    const facts = formatFfprobe({
      format: { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', bit_rate: '18000000', size: '27670908' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'prores',
          profile: '4444',
          width: 1920,
          height: 1080,
          r_frame_rate: '24/1',
          nb_frames: '300',
          pix_fmt: 'yuva444p10le',
          color_space: 'bt709',
          color_transfer: 'bt709',
          color_primaries: 'bt709',
          bit_rate: '16000000',
        },
        { codec_type: 'audio', codec_name: 'pcm_s24le', sample_rate: '48000', channels: 2, channel_layout: 'stereo', bit_rate: '2304000' },
      ],
    });
    expect(facts).toContain('Duration: 12.5 s');
    expect(facts).toContain('Container: mov,mp4,m4a,3gp,3g2,mj2');
    expect(facts).toContain('Format bitrate: 18000000');
    expect(facts).toContain('Streams: 1 video, 1 audio');
    expect(facts).toContain('Video: 1920x1080, 24 fps, prores 4444');
    expect(facts).toContain('Colour: bt709 / bt709 / bt709');
    expect(facts).toContain('Pixel format: yuva444p10le');
    expect(facts).toContain('Frames: 300');
    expect(facts).toContain('Audio: pcm_s24le, 48000 Hz, 2 ch, stereo, 2304000 bps');
  });
});

describe('preparedFromUri', () => {
  it('still attaches measured file size when the model only receives a Files API URI', () => {
    const prepared = preparedFromUri({
      id: 'd94aa665',
      name: 'Fieldnote Bakery Brand Guidelines (1).pdf',
      mime: 'application/pdf',
      sha256: '72b4a693',
      size: 27_670_908,
      uri: 'https://generativelanguage.googleapis.com/files/x',
      role: 'CONSIDERED OUTPUT',
    });
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('\n');
    expect(text).toContain('FILE FACTS');
    expect(text).toContain('File size: 26.4 MB (27670908 bytes)');
  });
});
