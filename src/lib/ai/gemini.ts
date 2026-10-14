import 'server-only';

import { createPartFromBase64, createPartFromText, createPartFromUri, FileState, GoogleGenAI, PartMediaResolutionLevel, type Part } from '@google/genai';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { geminiFiles, geminiFileUses } from '@/db/schema';
import { cachedGeminiUriDecision } from '@/domain/geminiFileCache';
import { shouldRetryWithoutSchema } from '@/domain/geminiSchema';
import { env, geminiMockEnabled } from '@/lib/env';
import { AdaptiveAdmission, type AdmissionOptions, type AdmissionSnapshot } from './admission';
import { modelContext } from './context';
import { throttleSharedAdmission, withSharedAdmission } from './sharedAdmission';
import { standInValue } from './standIn';

/**
 * One Gemini client for the whole process.
 *
 *  - Structured output (JSON schema) on every call; the model never answers
 *    in prose we then regex.
 *  - Every attempt is admitted by the adaptive controller (see admission.ts):
 *    AIMD concurrency, Retry-After cooldowns, per-task fairness and a
 *    reserved interactive slot. The controller learns from each outcome.
 *  - 429/5xx are retried with capped backoff honouring Retry-After. Schema,
 *    parse and refusal failures are NOT retried blindly — they are reported.
 *  - Files are staged once per content hash in the Files API and the handle
 *    is reused for 47 hours across full Golden, one-statement reassess, and
 *    Stability. The reaper deletes the handle when every using task has left
 *    grading, or when the TTL is up.
 */

export type GeminiErrorKind = 'not_configured' | 'rate_limit' | 'transport' | 'timeout' | 'invalid_output' | 'refused' | 'auth' | 'too_large';

export class GeminiError extends Error {
  constructor(
    public readonly kind: GeminiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface MediaPart {
  kind: 'uri' | 'inline';
  mime: string;
  /** Files API URI or base64 payload. */
  data: string;
  label: string;
}

export interface GenerateJsonInput<T> {
  model?: string;
  system: string;
  /** Ordered text/media; labels become `ATTACHED: <label>` markers before media. */
  parts: (string | MediaPart)[];
  schema: z.ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  /** 0 disables thinking (fast, deterministic grading). */
  thinkingBudget?: number;
  /** Extra abort; combined with the job/request signal. */
  signal?: AbortSignal;
  /** Fail this call if Gemini has not answered in time (does not change the process-wide HTTP timeout). */
  timeoutMs?: number;
  /** When false, skip responseJsonSchema and parse JSON from the text. */
  structured?: boolean;
}

export interface GenerateJsonResult<T> {
  value: T;
  model: string;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

let client: GoogleGenAI | null = null;
let admission: AdaptiveAdmission | null = null;

function geminiApiKey(): string {
  const key = env().GEMINI_API_KEY?.trim() ?? '';
  if (!key) throw new GeminiError('not_configured', 'GEMINI_API_KEY is not configured.');
  if (/^sk[-_]/.test(key)) {
    throw new GeminiError(
      'auth',
      'GEMINI_API_KEY is an OpenAI key. Replace it with a Google AI Studio key from https://aistudio.google.com/apikey, then restart the server.',
    );
  }
  return key;
}

function ai(): GoogleGenAI {
  const key = geminiApiKey();
  client ??= new GoogleGenAI({ apiKey: key, httpOptions: { timeout: env().GEMINI_TIMEOUT_MS } });
  return client;
}

async function admitted<T>(options: AdmissionOptions, operation: () => Promise<T>): Promise<T> {
  return controller().use(() => withSharedAdmission(options, operation), options);
}

function controller(): AdaptiveAdmission {
  if (!admission) {
    const e = env();
    admission = new AdaptiveAdmission({
      ceiling: e.GEMINI_CONCURRENCY,
      floor: e.GEMINI_CONCURRENCY_FLOOR,
      initial: e.GEMINI_CONCURRENCY_INITIAL,
      ownerCeiling: e.GEMINI_OWNER_CONCURRENCY,
      filesCeiling: e.GEMINI_FILES_CONCURRENCY,
      increaseAfter: e.GEMINI_INCREASE_AFTER,
    });
  }
  return admission;
}

/** Live controller state for the operations panel. */
export const modelTraffic = (): AdmissionSnapshot => controller().snapshot();

export const geminiConfigured = (): boolean => {
  const key = env().GEMINI_API_KEY?.trim() ?? '';
  return Boolean(key) && !/^sk[-_]/.test(key);
};

/** Throws if the key is missing or is an OpenAI key. GEMINI_MOCK=1 may run without a key. */
export function assertGeminiConfigured(): void {
  if (geminiMockEnabled()) return;
  geminiApiKey();
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function classify(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|quota exceeded/i.test(message)) {
    const retry = message.match(/retry in ([0-9a-z. ]+?)(?:\.|"|$)/i)?.[1]?.trim();
    const text = /free_tier|FreeTier/i.test(message)
      ? `Gemini key is on the free tier (20 requests/day for this model).${retry ? ` Retry in ${retry}.` : ''} Put a billed Tier 3 AI Studio key in .env.local and restart.`
      : retry
        ? `Gemini rate limit reached. Retry in ${retry}.`
        : 'Gemini rate limit reached.';
    return new GeminiError('rate_limit', text, status ?? 429);
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return new GeminiError('auth', 'Gemini rejected GEMINI_API_KEY. Paste a Google AI Studio key into .env.local and restart the server.', status ?? 400);
  }
  if (status === 413) return new GeminiError('too_large', 'The request is too large for Gemini.', status);
  if (status === 400 && /token|too large|exceeds/i.test(message)) return new GeminiError('too_large', message, status);
  if (status === 400) return new GeminiError('refused', message, status);
  if (status !== undefined && status >= 500) return new GeminiError('transport', `Gemini answered ${status}.`, status);
  if (/timeout|aborted|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message)) return new GeminiError('timeout', 'Gemini did not answer in time.');
  return new GeminiError('transport', message);
}

function retryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : '';
  const seconds = message.match(/retry(?:-| )after[^0-9]*([0-9.]+)\s*s/i)?.[1] ?? message.match(/"retryDelay":"([0-9.]+)s"/)?.[1];
  return seconds ? Math.min(120_000, Math.ceil(Number(seconds) * 1000)) : null;
}

const SEND_TEXT_CHARS = 12_000;

export function mediaResolutionFor(_mime: string): 'low' | 'medium' | 'high' {
  return 'medium';
}

function mediaResolution(mime: string): PartMediaResolutionLevel {
  const level = mediaResolutionFor(mime);
  if (level === 'high') return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
  if (level === 'low') return PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW;
  return PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM;
}

/** Drop empty text, clip long text, attach each media URI/inline once. */
export function tightenSendParts(parts: (string | MediaPart)[], textLimit = SEND_TEXT_CHARS): (string | MediaPart)[] {
  const out: (string | MediaPart)[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part === 'string') {
      const text = part.trim();
      if (!text) continue;
      out.push(text.length > textLimit ? `${text.slice(0, textLimit)}\n…` : text);
      continue;
    }
    const key = part.kind === 'uri' ? `uri:${part.data}` : `inline:${part.mime}:${part.data.length}:${part.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

export function inspectSendParts(parts: (string | MediaPart)[]): { textChars: number; textParts: number; inline: number; uris: number; videoInline: number } {
  let textChars = 0;
  let textParts = 0;
  let inline = 0;
  let uris = 0;
  let videoInline = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      textParts += 1;
      textChars += part.length;
      continue;
    }
    if (part.kind === 'uri') uris += 1;
    else {
      inline += 1;
      if (/^(video|audio)\//.test(part.mime)) videoInline += 1;
    }
  }
  return { textChars, textParts, inline, uris, videoInline };
}

function toParts(parts: (string | MediaPart)[]): Part[] {
  const out: Part[] = [];
  for (const part of tightenSendParts(parts)) {
    if (typeof part === 'string') {
      out.push(createPartFromText(part));
      continue;
    }
    const resolution = mediaResolution(part.mime);
    out.push(createPartFromText(`ATTACHED: ${part.label}`));
    out.push(part.kind === 'uri' ? createPartFromUri(part.data, part.mime, resolution) : createPartFromBase64(part.data, part.mime, resolution));
  }
  return out;
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const ac = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      ac.abort(s.reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export async function generateJson<T>(input: GenerateJsonInput<T>): Promise<GenerateJsonResult<T>> {
  const model = input.model ?? env().GEMINI_MODEL;
  const useStructured = input.structured !== false;
  const jsonSchema = useStructured ? z.toJSONSchema(input.schema, { target: 'draft-7', unrepresentable: 'any' }) : undefined;
  const contents = [{ role: 'user' as const, parts: toParts(input.parts) }];
  if (geminiMockEnabled() && !geminiConfigured()) {
    return {
      value: standInValue(input),
      model,
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs: 0,
    };
  }
  const attempts = 5;
  let useSchema = useStructured;
  const ctx = modelContext();
  const signal = mergeSignals(ctx.signal, input.signal);
  const gate = controller();
  const admit = { lane: model, requestClass: ctx.requestClass, ownerId: ctx.ownerId, signal };
  const budgetStarted = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    const remaining = input.timeoutMs ? input.timeoutMs - (Date.now() - budgetStarted) : undefined;
    if (remaining !== undefined && remaining <= 0) {
      throw new GeminiError('timeout', `Gemini did not answer within ${Math.round(input.timeoutMs! / 1000)}s.`);
    }
    let started = Date.now();
    try {
      const response = await admitted(admit, async () => {
        started = Date.now();
        const result = await raceDeadline(
          ai().models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: input.system,
              temperature: input.temperature ?? 0.2,
              maxOutputTokens: input.maxOutputTokens ?? 8192,
              responseMimeType: 'application/json',
              ...(useSchema ? { responseJsonSchema: jsonSchema } : {}),
              // Factory / lint / grade are structured JSON. Thinking is off unless
              // a caller opts in — Gemini 3 Flash otherwise spends seconds per seed.
              thinkingConfig: { thinkingBudget: input.thinkingBudget ?? 0 },
              ...(signal ? { abortSignal: signal } : {}),
            },
          }),
          remaining,
          signal,
        );
        gate.onSuccess(model, Date.now() - started);
        return result;
      });
      const text = response.text ?? '';
      const finish = response.candidates?.[0]?.finishReason;
      if (finish && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(String(finish))) {
        throw new GeminiError('refused', `Gemini refused to answer (${finish}).`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(stripFences(text));
      } catch {
        if (finish && /MAX_TOKENS/i.test(String(finish))) throw new GeminiError('invalid_output', 'Gemini output was truncated (max tokens).');
        throw new GeminiError('invalid_output', 'Gemini returned output that is not valid JSON.');
      }
      const parsed = input.schema.safeParse(raw);
      if (!parsed.success) {
        throw new GeminiError('invalid_output', `Gemini output did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'unknown'}.`);
      }
      const usage = response.usageMetadata;
      return {
        value: parsed.data,
        model,
        usage: {
          promptTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          totalTokens: usage?.totalTokenCount ?? 0,
        },
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof GeminiError ? reason : new GeminiError('timeout', 'The request was cancelled.');
      }
      const failure = classify(error);
      if (useSchema && shouldRetryWithoutSchema(failure)) {
        // Gemini often 400s the schema with a generic INVALID_ARGUMENT (Pietro's Generate).
        useSchema = false;
        continue;
      }
      if (failure.kind === 'invalid_output' && attempt < Math.min(2, attempts)) continue;
      const retryable = failure.kind === 'rate_limit' || failure.kind === 'transport' || failure.kind === 'timeout';
      const fallback = Math.min(45_000, 1_000 * 2 ** attempt + Math.random() * 750);
      let backoff = fallback;
      if (failure.kind === 'timeout' && input.timeoutMs) throw failure;
      if (failure.kind === 'rate_limit' && geminiMockEnabled()) {
        console.info('[gemini-send] 429 assumed landed (GEMINI_MOCK)', inspectSendParts(input.parts));
        return {
          value: standInValue(input),
          model,
          usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
          durationMs: Date.now() - started,
        };
      }
      if (failure.kind === 'rate_limit') {
        // The controller halves concurrency and opens a cooldown that every
        // other caller also respects; our own wait is at least that long.
        backoff = Math.max(fallback, gate.onThrottle(model, retryAfterMs(error), fallback));
        await throttleSharedAdmission(model, backoff);
      } else if (failure.kind === 'transport' || failure.kind === 'timeout') {
        gate.onFailure(model, failure.kind === 'timeout' ? 'timeout' : 'server');
      }
      // Daily / free-tier quota will not clear in this job — fail now so the UI shows why.
      if (failure.kind === 'rate_limit' && /free tier|retry in \d+h/i.test(failure.message)) throw failure;
      if (!retryable || attempt === attempts) throw failure;
      await sleep(backoff, signal);
    }
  }
  throw new GeminiError('transport', 'Gemini request failed.');
}

/** The SDK often ignores abortSignal. This is what actually stops a hung seed. */
function raceDeadline<T>(work: Promise<T>, timeoutMs: number | undefined, signal?: AbortSignal): Promise<T> {
  if (!timeoutMs && !signal) return work;
  return new Promise<T>((resolve, reject) => {
    const fail = (error: unknown) => {
      reject(error instanceof GeminiError ? error : new GeminiError('timeout', 'Gemini did not answer in time.'));
    };
    const timer = timeoutMs
      ? setTimeout(() => fail(new GeminiError('timeout', `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)
      : undefined;
    const onAbort = () => fail(signal?.reason instanceof GeminiError ? signal.reason : new GeminiError('timeout', 'The request was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

/* ─────────────────────────────────────────────── Files API ── */

const FILE_TTL_MS = 47 * 60 * 60_000; // provider keeps files 48h
/** Same cutoff as legacy: inline only when the file is under 12 MB and is not AV. */
const INLINE_LIMIT = 12 * 1024 * 1024;
const PDF_INLINE_LIMIT = 2 * 1024 * 1024;

/** Video/audio never travel in the generateContent body. Fat PDFs are staged too. */
export function shouldInlineMedia(mime: string, bytes: number): boolean {
  if (/^(video|audio)\//.test(mime)) return false;
  if (mime === 'application/pdf' && bytes > PDF_INLINE_LIMIT) return false;
  return bytes <= INLINE_LIMIT;
}

/**
 * A media part for `bytes`. Images under 12 MB travel inline. Video, audio,
 * and PDFs over 2 MB are staged once per sha256 — grade pings attach the URI,
 * not the file. Golden and AI output reuse that handle across batches/passes.
 */
export async function mediaPart(input: { bytes?: Uint8Array; mime: string; sha256: string; name: string; label: string }): Promise<MediaPart> {
  if (input.bytes && shouldInlineMedia(input.mime, input.bytes.byteLength)) {
    return { kind: 'inline', mime: input.mime, data: Buffer.from(input.bytes).toString('base64'), label: input.label };
  }
  const uri = input.bytes ? await stagedFileUri({ ...input, bytes: input.bytes }) : await lookupActiveFileUri(input.sha256);
  if (!uri) throw new GeminiError('transport', `${input.name} is not staged yet and no bytes were provided to upload it.`);
  return { kind: 'uri', mime: input.mime, data: uri, label: input.label };
}

const stagingInFlight = new Map<string, Promise<string>>();

const TASK_OWNER = /^task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function geminiFileName(uri: string): string {
  return uri.includes('/') ? uri.split('/').slice(-2).join('/') : uri;
}

/** Record that this task attached a staged object, so the reaper will not cull it early. */
export async function rememberGeminiUse(digest: string, submissionId?: string | null): Promise<void> {
  const id = submissionId ?? TASK_OWNER.exec(modelContext().ownerId)?.[1];
  if (!id || !digest) return;
  await db()
    .insert(geminiFileUses)
    .values({ sha256: digest, submissionId: id })
    .onConflictDoNothing();
}

/** Drop a Files API object. 404 is success — Gemini already expired it. */
export async function dropGeminiFile(uri: string): Promise<void> {
  if (geminiMockEnabled()) return;
  try {
    await ai().files.delete({ name: geminiFileName(uri) });
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
    if (status === 404 || status === 403) return;
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT_FOUND|not found|404/i.test(message)) return;
    throw error;
  }
}

/** Live Files API URI for this content hash, or null if we must upload. */
export async function lookupActiveFileUri(digest: string): Promise<string | null> {
  const database = db();
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const cached = (
    await database
      .select()
      .from(geminiFiles)
      .where(and(eq(geminiFiles.sha256, digest), gt(geminiFiles.expiresAt, soon)))
      .limit(1)
  )[0];
  if (!cached) return null;
  try {
    const file = await ai().files.get({ name: geminiFileName(cached.uri) });
    const decision = cachedGeminiUriDecision({ getFailed: false, state: file.state != null ? String(file.state) : null, uri: file.uri });
    if (decision === 'use') return file.uri ?? cached.uri;
    if (decision === 'keep') return cached.uri;
  } catch {
    if (cachedGeminiUriDecision({ getFailed: true }) === 'keep') return cached.uri;
  }
  await database.delete(geminiFiles).where(eq(geminiFiles.sha256, digest));
  return null;
}

async function stagedFileUri(input: { bytes: Uint8Array; mime: string; sha256: string; name: string }): Promise<string> {
  const pending = stagingInFlight.get(input.sha256);
  if (pending) return pending;
  const work = stagedFileUriOnce(input);
  stagingInFlight.set(input.sha256, work);
  try {
    return await work;
  } finally {
    if (stagingInFlight.get(input.sha256) === work) stagingInFlight.delete(input.sha256);
  }
}

async function stagedFileUriOnce(input: { bytes: Uint8Array; mime: string; sha256: string; name: string }): Promise<string> {
  const live = await lookupActiveFileUri(input.sha256);
  if (live) return live;
  const database = db();
  const ctx = modelContext();
  const gate = controller();
  const admit = { lane: 'files', requestClass: ctx.requestClass, ownerId: ctx.ownerId, signal: ctx.signal };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploaded = await admitted(admit, async () => {
        const started = Date.now();
        const blob = new Blob([Buffer.from(input.bytes)], { type: input.mime });
        const file = await ai().files.upload({ file: blob, config: { mimeType: input.mime, displayName: input.name.slice(0, 120) } });
        gate.onSuccess('files', Date.now() - started);
        return file;
      });
      // PROCESSING can take minutes on a 1 GB+ video. Do not hold the files
      // lane closed — other users still need to upload.
      let file = uploaded;
      const deadline = Date.now() + 20 * 60_000;
      while (file.state === FileState.PROCESSING && Date.now() < deadline) {
        await sleep(2_000, ctx.signal);
        try {
          file = await ai().files.get({ name: file.name! });
        } catch {
          /* status blip — keep polling the same handle, do not re-upload */
        }
      }
      if (file.state !== FileState.ACTIVE || !file.uri) {
        throw new GeminiError('transport', `Gemini could not process ${input.name} (${file.state ?? 'unknown state'}).`);
      }
      const uri = file.uri;
      await database
        .insert(geminiFiles)
        .values({ sha256: input.sha256, uri, mime: input.mime, size: input.bytes.byteLength, expiresAt: new Date(Date.now() + FILE_TTL_MS).toISOString() })
        .onConflictDoUpdate({ target: geminiFiles.sha256, set: { uri, expiresAt: new Date(Date.now() + FILE_TTL_MS).toISOString() } });
      await rememberGeminiUse(input.sha256);
      return uri;
    } catch (error) {
      const failure = classify(error);
      const fallback = Math.min(30_000, 2_000 * 2 ** attempt);
      if (failure.kind === 'rate_limit') {
        const wait = gate.onThrottle('files', retryAfterMs(error), fallback);
        await throttleSharedAdmission('files', wait);
        if (attempt < 3) {
          await sleep(Math.max(wait, fallback), ctx.signal);
          continue;
        }
      } else if (failure.kind === 'transport' || failure.kind === 'timeout') {
        gate.onFailure('files', failure.kind === 'timeout' ? 'timeout' : 'server');
        if (attempt < 3 && failure.status !== undefined && failure.status >= 500) {
          await sleep(fallback, ctx.signal);
          continue;
        }
      }
      throw failure;
    }
  }
  throw new GeminiError('transport', `Gemini could not stage ${input.name}.`);
}
