import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deterministic FILE FACTS for whatever deliverable we have.
 * Size is always measured from the stored bytes. Images, PDFs and
 * Office packages add header facts. Video/audio add ffprobe plus ffmpeg
 * level / loudness stats when present.
 */

export interface FileFactInput {
  name: string;
  mime: string;
  size: number;
  bytes?: Uint8Array;
}

export function formatFileSize(bytes: number): string {
  const mb = bytes / 1_048_576;
  return `File size: ${mb.toFixed(1)} MB (${bytes} bytes)`;
}

export function describeFileFacts(input: FileFactInput): string {
  const lines = [
    'FILE FACTS (measured from the file, authoritative for format statements):',
    formatFileSize(input.size),
    `Kind: ${kindOf(input)}`,
  ];
  if (input.bytes && input.bytes.byteLength > 0) {
    lines.push(...factsFromBytes(input.name, input.mime, input.bytes));
  }
  return lines.join('\n');
}

export async function describeFileFactsAsync(input: FileFactInput): Promise<string> {
  const base = describeFileFacts(input);
  if (!input.bytes || !isAv(input.mime, input.name)) return base;
  const probed = await avFacts(input.bytes, input.name);
  return probed ? `${base}\n${probed}` : base;
}

export interface AudioLevels {
  peakDbfs: number | null;
  rmsDbfs: number | null;
  leftRmsDbfs: number | null;
  rightRmsDbfs: number | null;
  channelDifferenceDb: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbfs: number | null;
  dcOffset: number | null;
  bitDepth: string | null;
  peakCount: number | null;
  clipping: boolean | null;
  leadingSilenceSec: number | null;
  trailingSilenceSec: number | null;
  internalSilenceGaps: number | null;
  longestSilenceSec: number | null;
  stereoCorrelation: number | null;
  stereoImage: 'dual-mono' | 'stereo' | 'out of phase' | null;
}

export function parseAudioLevels(log: string): AudioLevels | null {
  const channels = new Map<number, { peak: number | null; rms: number | null }>();
  let current: number | 'overall' | null = null;
  let overallPeak: number | null = null;
  let overallRms: number | null = null;
  let dcOffset: number | null = null;
  let bitDepth: string | null = null;
  let peakCount: number | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const channel = raw.match(/Channel:\s+(\d+)\s*$/);
    if (channel) {
      current = Number(channel[1]);
      if (!channels.has(current)) channels.set(current, { peak: null, rms: null });
      continue;
    }
    if (/\bOverall\s*$/.test(raw)) {
      current = 'overall';
      continue;
    }
    const peak = raw.match(/Peak level dB:\s+(-?(?:\d+(?:\.\d+)?|inf))\b/i);
    const rms = raw.match(/RMS level dB:\s+(-?(?:\d+(?:\.\d+)?|inf))\b/i);
    if (peak && current === 'overall') overallPeak = finiteDb(peak[1]);
    else if (peak && typeof current === 'number') {
      const row = channels.get(current) ?? { peak: null, rms: null };
      row.peak = finiteDb(peak[1]);
      channels.set(current, row);
    }
    if (rms && current === 'overall') overallRms = finiteDb(rms[1]);
    else if (rms && typeof current === 'number') {
      const row = channels.get(current) ?? { peak: null, rms: null };
      row.rms = finiteDb(rms[1]);
      channels.set(current, row);
    }
    if (current === 'overall') {
      const dc = raw.match(/DC offset:\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/i);
      const bits = raw.match(/Bit depth:\s+(\d+(?:\/\d+)+)/i);
      const peaks = raw.match(/(?<!Abs )Peak count:\s+(\d+(?:\.\d+)?)/i);
      if (dc) dcOffset = Number(dc[1]);
      if (bits) bitDepth = bits[1];
      if (peaks) peakCount = Math.round(Number(peaks[1]));
    }
  }
  const left = channels.get(1);
  const right = channels.get(2);
  const leftRms = left?.rms ?? null;
  const rightRms = right?.rms ?? null;
  const channelDifferenceDb = leftRms !== null && rightRms !== null ? round1(Math.abs(leftRms - rightRms)) : null;
  const integratedLufs = firstNumber(log, /\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS\b/);
  const loudnessRangeLu = firstNumber(log, /\bLRA:\s+(-?\d+(?:\.\d+)?)\s+LU\b/);
  const trueBlock = log.match(/True peak:[\s\S]*?Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/i);
  const truePeakDbfs = trueBlock ? round1(Number(trueBlock[1])) : null;
  const peakDbfs = overallPeak ?? left?.peak ?? null;
  const rmsDbfs = overallRms ?? left?.rms ?? null;
  const silence = parseSilence(log);
  const stereo = parseStereo(log);
  if (
    peakDbfs === null &&
    rmsDbfs === null &&
    channelDifferenceDb === null &&
    integratedLufs === null &&
    truePeakDbfs === null &&
    dcOffset === null &&
    silence.leadingSilenceSec === null &&
    stereo.stereoCorrelation === null
  ) {
    return null;
  }
  return {
    peakDbfs,
    rmsDbfs,
    leftRmsDbfs: leftRms,
    rightRmsDbfs: rightRms,
    channelDifferenceDb,
    integratedLufs,
    loudnessRangeLu,
    truePeakDbfs,
    dcOffset,
    bitDepth,
    peakCount,
    clipping: peakDbfs === null ? null : peakDbfs >= -0.05,
    ...silence,
    ...stereo,
  };
}

export function formatAudioLevels(levels: AudioLevels): string {
  const lines: string[] = [];
  if (levels.peakDbfs !== null) lines.push(`Peak level: ${fmt1(levels.peakDbfs)} dBFS`);
  if (levels.rmsDbfs !== null) lines.push(`RMS level: ${fmt1(levels.rmsDbfs)} dBFS`);
  if (levels.leftRmsDbfs !== null && levels.rightRmsDbfs !== null) {
    lines.push(`Left RMS: ${fmt1(levels.leftRmsDbfs)} dBFS; Right RMS: ${fmt1(levels.rightRmsDbfs)} dBFS`);
  }
  if (levels.channelDifferenceDb !== null) lines.push(`Channel level difference: ${fmt1(levels.channelDifferenceDb)} dB`);
  if (levels.integratedLufs !== null) lines.push(`Integrated loudness: ${fmt1(levels.integratedLufs)} LUFS`);
  if (levels.loudnessRangeLu !== null) lines.push(`Loudness range: ${fmt1(levels.loudnessRangeLu)} LU`);
  if (levels.truePeakDbfs !== null) lines.push(`True peak: ${fmt1(levels.truePeakDbfs)} dBTP`);
  if (levels.clipping !== null) lines.push(`Clipping: ${levels.clipping ? 'yes' : 'no'}`);
  if (levels.dcOffset !== null) lines.push(`DC offset: ${levels.dcOffset.toFixed(6)}`);
  if (levels.bitDepth) lines.push(`Bit depth: ${levels.bitDepth}`);
  if (levels.peakCount !== null) lines.push(`Peak count: ${levels.peakCount}`);
  if (levels.leadingSilenceSec !== null) lines.push(`Leading silence: ${fmt2(levels.leadingSilenceSec)} s`);
  if (levels.trailingSilenceSec !== null) lines.push(`Trailing silence: ${fmt2(levels.trailingSilenceSec)} s`);
  if (levels.internalSilenceGaps !== null) lines.push(`Internal silence gaps: ${levels.internalSilenceGaps}`);
  if (levels.longestSilenceSec !== null) lines.push(`Longest silence: ${fmt2(levels.longestSilenceSec)} s`);
  if (levels.stereoCorrelation !== null && levels.stereoImage) {
    lines.push(`Stereo correlation: ${fmt2(levels.stereoCorrelation)} (${levels.stereoImage})`);
  }
  return lines.join('\n');
}

function finiteDb(raw: string | undefined): number | null {
  if (!raw || /inf/i.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? round1(value) : null;
}

function firstNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? round1(value) : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fmt1(value: number): string {
  return value.toFixed(1);
}

function fmt2(value: number): string {
  return value.toFixed(2);
}

function parseDurationSec(log: string): number | null {
  const match = log.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

function parseSilence(log: string): Pick<
  AudioLevels,
  'leadingSilenceSec' | 'trailingSilenceSec' | 'internalSilenceGaps' | 'longestSilenceSec'
> {
  const empty = {
    leadingSilenceSec: null,
    trailingSilenceSec: null,
    internalSilenceGaps: null,
    longestSilenceSec: null,
  };
  const durationSec = parseDurationSec(log);
  if (durationSec === null) return empty;
  const gaps: { start: number; end: number; duration: number }[] = [];
  let pendingStart: number | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const start = raw.match(/silence_start:\s+(-?\d+(?:\.\d+)?)/);
    if (start) {
      pendingStart = Number(start[1]);
      continue;
    }
    const end = raw.match(/silence_end:\s+(-?\d+(?:\.\d+)?)(?:.*silence_duration:\s+(-?\d+(?:\.\d+)?))?/);
    if (end && pendingStart !== null) {
      const endSec = Number(end[1]);
      const length = end[2] !== undefined ? Number(end[2]) : endSec - pendingStart;
      gaps.push({ start: pendingStart, end: endSec, duration: length });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    gaps.push({ start: pendingStart, end: durationSec, duration: durationSec - pendingStart });
  }
  if (gaps.length === 0) {
    return {
      leadingSilenceSec: 0,
      trailingSilenceSec: 0,
      internalSilenceGaps: 0,
      longestSilenceSec: 0,
    };
  }
  const edge = 0.05;
  const leading = gaps.find((gap) => gap.start <= edge);
  const trailing = [...gaps].reverse().find((gap) => gap.end >= durationSec - edge);
  const internal = gaps.filter((gap) => gap !== leading && gap !== trailing);
  let longest = gaps[0]!.duration;
  for (const gap of gaps) {
    if (gap.duration > longest) longest = gap.duration;
  }
  return {
    leadingSilenceSec: round2(leading?.duration ?? 0),
    trailingSilenceSec: round2(trailing?.duration ?? 0),
    internalSilenceGaps: internal.length,
    longestSilenceSec: round2(longest),
  };
}

function parseStereo(log: string): Pick<AudioLevels, 'stereoCorrelation' | 'stereoImage'> {
  const samples: number[] = [];
  for (const match of log.matchAll(/phase[=:]\s*(-?\d+(?:\.\d+)?)/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) samples.push(value);
  }
  if (!samples.length) return { stereoCorrelation: null, stereoImage: null };
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const stereoCorrelation = round2(mean);
  const stereoImage =
    stereoCorrelation < 0 ? 'out of phase' : stereoCorrelation >= 0.9 ? 'dual-mono' : 'stereo';
  return { stereoCorrelation, stereoImage };
}

function kindOf(input: FileFactInput): string {
  const mime = input.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'application/pdf' || /\.pdf$/i.test(input.name)) return 'PDF document';
  if (mime.startsWith('image/')) return `image (${mime.slice(6)})`;
  if (mime.startsWith('video/')) return `video (${mime.slice(6)})`;
  if (mime.startsWith('audio/')) return `audio (${mime.slice(6)})`;
  if (/\.pptx?$/i.test(input.name)) return 'PowerPoint deck';
  if (/\.docx?$/i.test(input.name)) return 'Word document';
  if (/\.xlsx?$/i.test(input.name)) return 'Excel workbook';
  return mime || 'file';
}

function isAv(mime: string, name: string): boolean {
  return /^(video|audio)\//.test(mime) || /\.(mp4|mov|m4v|webm|avi|mkv|mp3|wav|m4a|aac)$/i.test(name);
}

function factsFromBytes(name: string, mime: string, bytes: Uint8Array): string[] {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return pdfFacts(bytes);
  return imageFacts(bytes);
}

function pdfText(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 32_000_000))).toString('latin1');
  return text.includes('%PDF-') ? text : null;
}

export function pdfPageCount(bytes: Uint8Array): number | null {
  const text = pdfText(bytes);
  if (!text) return null;
  let best = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]*\/Count\s+(\d+)/g)) {
    best = Math.max(best, Number(match[1]));
  }
  if (best > 0) return best;
  const pages = text.match(/\/Type\s*\/Page(?!s)\b/g);
  return pages?.length ?? null;
}

function pdfFacts(bytes: Uint8Array): string[] {
  const text = pdfText(bytes);
  if (!text) return [];
  const lines: string[] = [];
  const version = text.match(/%PDF-(\d+\.\d+)/)?.[1];
  if (version) lines.push(`PDF version: ${version}`);
  const pages = pdfPageCount(bytes);
  if (pages !== null) lines.push(`Pages: ${pages}`);
  lines.push(`Encrypted: ${/\/Encrypt\b/.test(text) ? 'yes' : 'no'}`);
  const box = text.match(/\/MediaBox\s*\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\]/);
  if (box) {
    const width = Number(box[3]) - Number(box[1]);
    const height = Number(box[4]) - Number(box[2]);
    if (width > 0 && height > 0) {
      lines.push(`Page size: ${width.toFixed(2)} x ${height.toFixed(2)} pt, aspect ${aspectOf(width, height)}`);
    }
  }
  const producer = pdfString(text, 'Producer');
  if (producer) lines.push(`Producer: ${producer}`);
  const creator = pdfString(text, 'Creator');
  if (creator) lines.push(`Creator: ${creator}`);
  return lines;
}

function pdfString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`/${key}\\s*\\(([^)]{1,120})\\)`));
  return match?.[1]?.trim() || null;
}

function imageFacts(bytes: Uint8Array): string[] {
  if (bytes.byteLength >= 25 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = readU32(bytes, 16);
    const height = readU32(bytes, 20);
    const depth = bytes[24]!;
    const colour = PNG_COLOUR[bytes[25]!] ?? `type ${bytes[25]}`;
    const interlace = bytes[28] === 1 ? 'interlaced' : 'non-interlaced';
    return [`Dimensions: ${width} x ${height}`, `Bit depth: ${depth}`, `Colour: ${colour}`, `Interlace: ${interlace}`];
  }
  if (bytes.byteLength >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes[6]! | (bytes[7]! << 8);
    const height = bytes[8]! | (bytes[9]! << 8);
    return [`Dimensions: ${width} x ${height}`, `Colour: ${bytes[4] === 0x39 ? 'GIF89a' : 'GIF87a'}`];
  }
  if (bytes.byteLength >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const tag = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (tag === 'VP8X') {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      const alpha = ((bytes[20] ?? 0) & 0x10) !== 0;
      return [`Dimensions: ${width} x ${height}`, `Colour: WebP VP8X${alpha ? ' with alpha' : ''}`];
    }
    if (tag === 'VP8 ') {
      return [`Dimensions: ${bytes[26]! | (bytes[27]! << 8)} x ${bytes[28]! | (bytes[29]! << 8)}`, 'Colour: WebP VP8'];
    }
    if (tag === 'VP8L') return ['Colour: WebP lossless'];
  }
  return jpegFacts(bytes) ?? [];
}

const PNG_COLOUR: Record<number, string> = {
  0: 'greyscale',
  2: 'RGB',
  3: 'indexed',
  4: 'greyscale+alpha',
  6: 'RGBA',
};

export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const line = imageFacts(bytes).find((row) => row.startsWith('Dimensions: '));
  const match = line?.match(/Dimensions: (\d+) x (\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function jpegFacts(bytes: Uint8Array): string[] | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.byteLength) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1]!;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const bits = bytes[i + 4]!;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      const components = bytes[i + 9];
      const kind = marker === 0xc2 ? 'progressive' : 'baseline';
      const colour = components === 1 ? 'greyscale' : components === 4 ? 'CMYK' : 'YCbCr';
      return [`Dimensions: ${width} x ${height}`, `Bit depth: ${bits}`, `Colour: ${colour}`, `JPEG: ${kind}`];
    }
    i += 2 + length;
  }
  return null;
}

function aspectOf(width: number, height: number): string {
  const ratio = width / height;
  const known: [string, number][] = [['16:9', 16 / 9], ['4:3', 4 / 3], ['16:10', 1.6], ['A4 portrait', 210 / 297], ['A4 landscape', 297 / 210], ['1:1', 1]];
  const match = known.find(([, value]) => Math.abs(value - ratio) < 0.02);
  return match ? match[0] : ratio.toFixed(3);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_frames?: string;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

export interface FfprobeJson {
  format?: { duration?: string; format_name?: string; bit_rate?: string; size?: string };
  streams?: FfprobeStream[];
}

async function avFacts(bytes: Uint8Array, name: string): Promise<string | null> {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'bin';
  const dir = await mkdtemp(join(tmpdir(), 'gdp-probe-'));
  const input = join(dir, `source.${ext}`);
  try {
    await writeFile(input, bytes);
    const [probeRaw, levelLog, phaseLog] = await Promise.all([
      runFfprobe(input),
      runFfmpegLevels(input),
      runFfmpegPhase(input),
    ]);
    const lines: string[] = [];
    if (probeRaw) {
      const formatted = formatFfprobe(JSON.parse(probeRaw) as FfprobeJson);
      if (formatted) lines.push(formatted);
    }
    const combinedLog = [levelLog, phaseLog].filter(Boolean).join('\n');
    const levels = combinedLog ? parseAudioLevels(combinedLog) : null;
    if (levels) lines.push(formatAudioLevels(levels));
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function formatFfprobe(parsed: FfprobeJson): string | null {
  const lines: string[] = [];
  const duration = Number(parsed.format?.duration ?? NaN);
  if (Number.isFinite(duration)) lines.push(`Duration: ${duration.toFixed(1)} s`);
  if (parsed.format?.format_name) lines.push(`Container: ${parsed.format.format_name}`);
  if (parsed.format?.bit_rate) lines.push(`Format bitrate: ${parsed.format.bit_rate}`);
  const streams = parsed.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === 'video').length;
  const audios = streams.filter((stream) => stream.codec_type === 'audio').length;
  if (streams.length) lines.push(`Streams: ${videos} video, ${audios} audio`);
  for (const stream of streams) {
    if (stream.codec_type === 'video' && stream.width && stream.height) {
      const fps = fpsOf(stream.r_frame_rate);
      const codec = [stream.codec_name, stream.profile].filter(Boolean).join(' ');
      lines.push(`Video: ${stream.width}x${stream.height}${fps ? `, ${fps} fps` : ''}${codec ? `, ${codec}` : ''}`);
      if (stream.pix_fmt) lines.push(`Pixel format: ${stream.pix_fmt}`);
      const colour = [stream.color_space, stream.color_transfer, stream.color_primaries].filter(Boolean).join(' / ');
      if (colour) lines.push(`Colour: ${colour}`);
      if (stream.nb_frames) lines.push(`Frames: ${stream.nb_frames}`);
      if (stream.bit_rate) lines.push(`Video bitrate: ${stream.bit_rate}`);
    }
    if (stream.codec_type === 'audio') {
      const bits = [
        stream.codec_name ?? 'audio',
        stream.sample_rate ? `${stream.sample_rate} Hz` : '',
        stream.channels ? `${stream.channels} ch` : '',
        stream.channel_layout ?? '',
        stream.bit_rate ? `${stream.bit_rate} bps` : '',
      ].filter(Boolean);
      lines.push(`Audio: ${bits.join(', ')}`);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

function fpsOf(rate?: string): string | null {
  if (!rate || rate === '0/0') return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return rate;
  return (n / d).toFixed(n % d === 0 ? 0 : 2);
}

function runFfprobe(path: string): Promise<string | null> {
  return spawnText(process.env['FFPROBE_BIN']?.trim() || 'ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path], 'stdout', 15_000);
}

function runFfmpegLevels(path: string): Promise<string | null> {
  return spawnText(
    process.env['FFMPEG_BIN']?.trim() || 'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'astats=metadata=1:reset=1,ebur128,silencedetect=noise=-40dB:duration=0.25', '-f', 'null', '-'],
    'stderr',
    45_000,
  );
}

function runFfmpegPhase(path: string): Promise<string | null> {
  return spawnText(
    process.env['FFMPEG_BIN']?.trim() || 'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'aphasemeter=video=0,ametadata=print:key=lavfi.aphasemeter.phase', '-f', 'null', '-'],
    'stderr',
    45_000,
  );
}

function spawnText(bin: string, args: string[], stream: 'stdout' | 'stderr', timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(/* turbopackIgnore: true */ bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child[stream]?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.trim() ? text : null);
    });
  });
}
