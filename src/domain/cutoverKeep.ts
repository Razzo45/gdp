/**
 * Freeze keep-set: live Replit board rows the PM named, plus 1704127a.
 * Short prefixes match Catalog UUIDs. Anything else lands later at K/E.
 */
export const CUTOVER_KEEP_PREFIXES = [
  '22c685ba',
  '3259ad13',
  'e062bda1',
  '54fd7011',
  '80ba20f0',
  'ba0e8353',
  '93a8a4cc',
  'c616faf6',
  '1aca51c9',
  '7f1b0b44',
  '8a0c38c4',
  '28bb831c',
  '60dcd5ca',
  '5752d2eb',
  '27f6a0de',
  '1704127a',
  '01c420db',
  '227841fd',
  '4929aa3e',
  '4e0409d0',
  '4e2f906b',
  '54d0b3ff',
  '868afbd1',
  '87a77f60',
  '966ebd18',
  'a002e716',
  'af1c7423',
  'bf7722e4',
  'dd823796',
] as const;

export function keepCatalogId(catalogId: string | null | undefined, prefixes: readonly string[] = CUTOVER_KEEP_PREFIXES): boolean {
  const id = String(catalogId ?? '').trim().toLowerCase();
  if (!id) return false;
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(prefix));
}
