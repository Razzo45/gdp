/** One-statement (or few-seat) Golden reassess — the fast lane. */
export const STATEMENT_LANE_MAX = 8;

/** Video/audio (any size) or a 100 MB+ file — staging plus grade pings are long. */
export const HEAVY_FILE_BYTES = 100 * 1024 * 1024;
/** Other users keep the remaining worker slots while these run. */
export const HEAVY_RUNNING_MAX = 2;

export function isHeavyMedia(file: { mime?: string; name?: string; size?: number }): boolean {
  const mime = (file.mime ?? '').toLowerCase();
  const name = file.name ?? '';
  if (/^(video|audio)\//.test(mime) || /\.(mp4|mov|m4v|webm|avi|mkv|mp3|wav|m4a)$/i.test(name)) return true;
  return (file.size ?? 0) >= HEAVY_FILE_BYTES;
}

export function isHeavyJobPayload(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.['heavy'] === true;
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
