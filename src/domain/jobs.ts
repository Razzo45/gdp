import { STABILITY_PASSES } from '@/domain/gates';

/** One-statement (or few-seat) Golden reassess — the fast lane. */
export const STATEMENT_LANE_MAX = 8;

/** Video/audio (any size) or a 100 MB+ non-zip file — staging plus grade pings are long. */
export const HEAVY_FILE_BYTES = 100 * 1024 * 1024;
/** Site zips above this unpack into many HTML/CSS/JS parts; those members go to the Files API instead of the generate body. */
export const ARCHIVE_STAGE_BYTES = 8 * 1024 * 1024;
/** Other users keep the remaining worker slots while a video/100 MB+ file runs. */
export const HEAVY_RUNNING_MAX = 2;
/** One site-zip unpack/grade at a time. Does not take a video heavy slot. */
export const ARCHIVE_RUNNING_MAX = 1;
/** "Get under 50%" runs for many minutes; the rest of the worker stays free for everyone else. */
export const HELPER_RUNNING_MAX = 1;

export function isArchiveFile(file: { mime?: string; name?: string }): boolean {
  const mime = (file.mime ?? '').toLowerCase();
  const name = file.name ?? '';
  return /^(application\/(zip|x-zip-compressed|x-zip)|multipart\/x-zip)$/.test(mime) || /\.zip$/i.test(name);
}

export function isHeavyMedia(file: { mime?: string; name?: string; size?: number }): boolean {
  if (isArchiveFile(file)) return false;
  const mime = (file.mime ?? '').toLowerCase();
  const name = file.name ?? '';
  if (/^(video|audio)\//.test(mime) || /\.(mp4|mov|m4v|webm|avi|mkv|mp3|wav|m4a)$/i.test(name)) return true;
  return (file.size ?? 0) >= HEAVY_FILE_BYTES;
}

export function isHeavyJobPayload(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.['heavy'] === true;
}

export function isArchiveJobPayload(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.['archive'] === true;
}

/** Three parallel full-site grades of a staged zip OOM the embedded worker. Video stays serial for the same reason. */
export function stabilityGradesInParallel(payload: Record<string, unknown> | null | undefined): boolean {
  return !isHeavyJobPayload(payload) && !isArchiveJobPayload(payload);
}

export function archiveMembersStayStaged(archiveBytes: number): boolean {
  return archiveBytes >= ARCHIVE_STAGE_BYTES;
}

/** No Stability lane batches seats. Packing seats in one call bleeds verdicts. */
export function stabilityGradeBatchSize(_payload: Record<string, unknown> | null | undefined): number | undefined {
  return undefined;
}

/** Gemini grade calls for a Stability run (one observation group, all seats). */
export function stabilityGradeCalls(seats: number, payload: Record<string, unknown> | null | undefined): number {
  const batch = stabilityGradeBatchSize(payload) ?? 1;
  return Math.ceil(Math.max(0, seats) / batch) * STABILITY_PASSES;
}

export function statementIdsOf(payload: Record<string, unknown> | null | undefined): string[] {
  const ids = payload?.['statementIds'];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export function isStatementLane(payload: Record<string, unknown> | null | undefined): boolean {
  const ids = statementIdsOf(payload);
  return ids.length > 0 && ids.length <= STATEMENT_LANE_MAX;
}

/** Images, AV, PDF can ride a live Files API URI. Size facts still come from the stored byte count. Office/zip still need bytes for package FILE FACTS. */
export function canReuseStagedUri(mime: string, name: string): boolean {
  const clean = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (/^(image\/|video\/|audio\/|application\/pdf)/.test(clean)) return true;
  return /\.(png|jpe?g|webp|gif|heic|heif|mp4|mov|webm|mp3|wav|m4a|pdf)$/i.test(name);
}

/** Same Catalog object as last time we hashed it — size plus ETag when both exist. */
export function catalogIdentityMatch(cached: { size: number; etag: string | null }, probe: { size: number; etag: string | null }): boolean {
  if (cached.size !== probe.size || cached.size <= 0) return false;
  if (cached.etag && probe.etag) return cached.etag === probe.etag;
  return true;
}

/** Two one-statement reassessments can run together. A full Golden still owns the lane. */
export function conflictingJob<T extends { kind: string; payload: Record<string, unknown> }>(kind: string, payload: Record<string, unknown>, actives: T[]): T | undefined {
  if (kind !== 'golden_autorate') return actives[0];
  const incomingFast = isStatementLane(payload);
  const incomingIds = new Set(statementIdsOf(payload));
  for (const job of actives) {
    if (!incomingFast || !isStatementLane(job.payload)) return job;
    if (statementIdsOf(job.payload).some((id) => incomingIds.has(id))) return job;
  }
  return undefined;
}
