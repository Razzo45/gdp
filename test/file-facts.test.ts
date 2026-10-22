import { describe, expect, it } from 'vitest';
import { describeFileFacts, describeFileFactsAsync, factsFullyMeasured, formatAudioLevels, formatFfprobe, parseAudioLevels } from '@/lib/ai/fileFacts';
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

const FFMPEG_LEVELS = `
[Parsed_astats_0 @ 0x1] Channel: 1
[Parsed_astats_0 @ 0x1] Peak level dB: -1.20
[Parsed_astats_0 @ 0x1] RMS level dB: -18.30
[Parsed_astats_0 @ 0x1] Channel: 2
[Parsed_astats_0 @ 0x1] Peak level dB: -1.40
[Parsed_astats_0 @ 0x1] RMS level dB: -18.50
[Parsed_astats_0 @ 0x1] Overall
[Parsed_astats_0 @ 0x1] Peak level dB: -1.20
[Parsed_astats_0 @ 0x1] RMS level dB: -18.40
[Parsed_ebur128_0 @ 0x2] Summary:

  Integrated loudness:
    I:         -16.3 LUFS
    Threshold: -26.2 LUFS

  Loudness range:
    LRA:         5.2 LU
    Threshold: -36.1 LUFS
    LRA low:   -21.2 LUFS
    LRA high:  -16.0 LUFS

  True peak:
    Peak:       -1.1 dBFS
`;

describe('audio level FILE FACTS', () => {
  it('reads peak, RMS, left-right difference, LUFS and true peak from ffmpeg', () => {
    const levels = parseAudioLevels(FFMPEG_LEVELS);
    expect(levels).toEqual({
      peakDbfs: -1.2,
      rmsDbfs: -18.4,
      leftRmsDbfs: -18.3,
      rightRmsDbfs: -18.5,
      channelDifferenceDb: 0.2,
      integratedLufs: -16.3,
      loudnessRangeLu: 5.2,
      truePeakDbfs: -1.1,
      dcOffset: null,
      bitDepth: null,
      peakCount: null,
      clipping: false,
      leadingSilenceSec: null,
      trailingSilenceSec: null,
      internalSilenceGaps: null,
      longestSilenceSec: null,
      stereoCorrelation: null,
      stereoImage: null,
    });
    const text = formatAudioLevels(levels!);
    expect(text).toContain('Peak level: -1.2 dBFS');
    expect(text).toContain('RMS level: -18.4 dBFS');
    expect(text).toContain('Left RMS: -18.3 dBFS; Right RMS: -18.5 dBFS');
    expect(text).toContain('Channel level difference: 0.2 dB');
    expect(text).toContain('Integrated loudness: -16.3 LUFS');
    expect(text).toContain('Loudness range: 5.2 LU');
    expect(text).toContain('True peak: -1.1 dBTP');
    expect(text).toContain('Clipping: no');
  });

  it('reads clipping, silence gaps, stereo correlation, DC offset and bit depth', () => {
    const levels = parseAudioLevels(`
Duration: 00:00:10.00, start: 0.000000, bitrate: 2304 kb/s
[Parsed_astats_0 @ 0x1] Overall
[Parsed_astats_0 @ 0x1] DC offset: 0.000012
[Parsed_astats_0 @ 0x1] Peak level dB: 0.00
[Parsed_astats_0 @ 0x1] RMS level dB: -12.00
[Parsed_astats_0 @ 0x1] Peak count: 48.000000
[Parsed_astats_0 @ 0x1] Abs Peak count: 48.000000
[Parsed_astats_0 @ 0x1] Bit depth: 24/24/24/24
[silencedetect @ 0x3] silence_start: 0
[silencedetect @ 0x3] silence_end: 0.40 | silence_duration: 0.40
[silencedetect @ 0x3] silence_start: 4.00
[silencedetect @ 0x3] silence_end: 4.80 | silence_duration: 0.80
[silencedetect @ 0x3] silence_start: 9.50
[silencedetect @ 0x3] silence_end: 10.00 | silence_duration: 0.50
[Parsed_ametadata_1 @ 0x4] lavfi.aphasemeter.phase=0.12
[Parsed_ametadata_1 @ 0x4] lavfi.aphasemeter.phase=0.14
`);
    expect(levels).toMatchObject({
      clipping: true,
      dcOffset: 0.000012,
      bitDepth: '24/24/24/24',
      peakCount: 48,
      leadingSilenceSec: 0.4,
      trailingSilenceSec: 0.5,
      internalSilenceGaps: 1,
      longestSilenceSec: 0.8,
      stereoCorrelation: 0.13,
      stereoImage: 'stereo',
    });
    const text = formatAudioLevels(levels!);
    expect(text).toContain('Clipping: yes');
    expect(text).toContain('DC offset: 0.000012');
    expect(text).toContain('Bit depth: 24/24/24/24');
    expect(text).toContain('Peak count: 48');
    expect(text).toContain('Leading silence: 0.40 s');
    expect(text).toContain('Trailing silence: 0.50 s');
    expect(text).toContain('Internal silence gaps: 1');
    expect(text).toContain('Longest silence: 0.80 s');
    expect(text).toContain('Stereo correlation: 0.13 (stereo)');
  });
});

describe('describeFileFactsAsync', () => {
  it('says the stream facts were not measured when ffprobe returns nothing, and marks them uncacheable', async () => {
    const saved = { probe: process.env['FFPROBE_BIN'], mpeg: process.env['FFMPEG_BIN'] };
    process.env['FFPROBE_BIN'] = 'gdp-missing-ffprobe';
    process.env['FFMPEG_BIN'] = 'gdp-missing-ffmpeg';
    try {
      const facts = await describeFileFactsAsync({ name: 'clip.mp4', mime: 'video/mp4', size: 4, bytes: Uint8Array.from([0, 0, 0, 0]) });
      expect(facts).toMatch(/NOT MEASURED/);
      expect(factsFullyMeasured(facts)).toBe(false);
    } finally {
      if (saved.probe === undefined) delete process.env['FFPROBE_BIN'];
      else process.env['FFPROBE_BIN'] = saved.probe;
      if (saved.mpeg === undefined) delete process.env['FFMPEG_BIN'];
      else process.env['FFMPEG_BIN'] = saved.mpeg;
    }
  });
});

describe('preparedFromUri', () => {
  it('attaches the stored measured facts when the model only receives a Files API URI', () => {
    const facts = describeFileFacts({ name: 'guide.pdf', mime: 'application/pdf', size: 27_670_908, bytes: ONE_PAGE_PDF });
    const prepared = preparedFromUri({
      id: 'd94aa665',
      name: 'Fieldnote Bakery Brand Guidelines (1).pdf',
      mime: 'application/pdf',
      sha256: '72b4a693',
      size: 27_670_908,
      uri: 'https://generativelanguage.googleapis.com/files/x',
      role: 'CONSIDERED OUTPUT',
      facts,
    });
    const text = prepared.parts.filter((part): part is string => typeof part === 'string').join('\n');
    expect(text).toContain('File size: 26.4 MB (27670908 bytes)');
    expect(text).toContain('Pages: 1');
  });
});
