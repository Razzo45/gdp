/** Catalog file URLs. `view` is the 24h preview link; `download` is often 5 minutes. */

export function catalogFileUrls(urls?: { download?: string; view?: string; preview?: string; thumbnail?: string }): {
  downloadUrl: string | null;
  previewUrl: string | null;
  thumbnailUrl: string | null;
} {
  const download = urls?.download?.trim() || null;
  const view = urls?.view?.trim() || null;
  const preview = urls?.preview?.trim() || null;
  return {
    downloadUrl: download ?? view,
    previewUrl: preview ?? view,
    thumbnailUrl: urls?.thumbnail?.trim() || null,
  };
}

/** Prefer a live download URL; fall back to the longer-lived view/preview link. */
export function preferredCatalogBytesUrl(
  file: { downloadUrl: string | null; previewUrl: string | null },
  isStale: (url: string) => boolean,
): string | null {
  if (file.downloadUrl && !isStale(file.downloadUrl)) return file.downloadUrl;
  if (file.previewUrl && !isStale(file.previewUrl)) return file.previewUrl;
  return file.downloadUrl ?? file.previewUrl ?? null;
}

const DEFAULT_BUFFER_BYTES = 80 * 1024 * 1024;

/** Stream Range requests; buffer mid-size full downloads so Next/Railway can return the body. */
export function shouldBufferProxiedFile(input: { hasRange: boolean; contentLength: number; maxBytes?: number }): boolean {
  if (input.hasRange) return false;
  if (input.contentLength <= 0) return false;
  return input.contentLength <= (input.maxBytes ?? DEFAULT_BUFFER_BYTES);
}
