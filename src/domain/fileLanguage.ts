/**
 * Statements talk about the file by role ("the delivered presentation"),
 * not by a Catalog filename. Autorate already grades the current Golden /
 * AI set; a literal name.ext only pins the wrong file on the next upload.
 */

const ROLE: Record<string, string> = {
  pptx: 'delivered presentation',
  ppt: 'delivered presentation',
  pdf: 'delivered PDF',
  docx: 'delivered document',
  doc: 'delivered document',
  xlsx: 'delivered workbook',
  xls: 'delivered workbook',
  csv: 'delivered workbook',
  png: 'delivered image',
  jpg: 'delivered image',
  jpeg: 'delivered image',
  webp: 'delivered image',
  gif: 'delivered image',
  svg: 'delivered image',
  heic: 'delivered image',
  psd: 'delivered image',
  mp4: 'delivered video',
  mov: 'delivered video',
  webm: 'delivered video',
  mp3: 'delivered audio',
  wav: 'delivered audio',
  m4a: 'delivered audio',
  zip: 'delivered package',
  html: 'delivered file',
  txt: 'delivered file',
  md: 'delivered file',
};

const NAMED_FILE =
  /\b(?:the\s+)?[A-Za-z0-9][\w.-]*\.(pptx|ppt|pdf|docx|doc|xlsx|xls|csv|png|jpe?g|webp|gif|svg|heic|psd|mp4|mov|webm|mp3|wav|m4a|zip|html|txt|md)\b/gi;

/** `q3-deck.pptx` → `the delivered presentation`. Leaves already-descriptive wording alone. */
export function describeNamedFiles(statement: string): string {
  const next = statement.replace(NAMED_FILE, (match, ext: string, offset: number) => {
    const role = ROLE[ext.toLowerCase()] ?? 'delivered file';
    const phrase = `the ${role}`;
    const before = statement.slice(0, offset);
    const atStart = before.trim() === '' || /[.!?]\s*$/.test(before);
    return atStart ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}` : phrase;
  });
  return next.replace(/\bthe the\b/gi, 'the').replace(/ {2,}/g, ' ').trim();
}
