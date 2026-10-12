/** Files at or under this size go through the app POST, not a signed PUT. */
export const DIRECT_AI_UPLOAD_BYTES = 8 * 1024 * 1024;

export function prefersDirectAiUpload(size: number): boolean {
  return Number.isFinite(size) && size > 0 && size <= DIRECT_AI_UPLOAD_BYTES;
}
