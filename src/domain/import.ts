import { toAffirmativeStatement } from './lint';
import { correctTag, RUBRIC_TAGS, type RubricTag } from './rubric';

/**
 * Parses pasted text into statements. One per line; an optional leading
 * `Tag |` or `Tag:` picks the tag; questions become affirmatives;
 * blank lines, numbering and bullets are ignored.
 */
export function parseImport(text: string): { rows: { tag: RubricTag; statement: string }[]; skipped: string[] } {
  const rows: { tag: RubricTag; statement: string }[] = [];
  const skipped: string[] = [];
  const tagIndex = new Map(RUBRIC_TAGS.map((t) => [t.toLowerCase().replace(/[^a-z]/g, ''), t]));
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)]|s\d{3}[:.)])\s*/i, '').trim();
    if (!line) continue;
    let tag: RubricTag = 'Content - Semantics';
    const split = line.match(/^([^|:]{3,40})\s*[|:]\s*(.+)$/);
    if (split) {
      const found = tagIndex.get(split[1]!.toLowerCase().replace(/[^a-z]/g, ''));
      if (found) {
        tag = found;
        line = split[2]!.trim();
      }
    }
    const statement = toAffirmativeStatement(line);
    if (statement.length < 8 || statement.length > 600) {
      skipped.push(rawLine.trim());
      continue;
    }
    rows.push({ tag: correctTag(statement, tag), statement });
  }
  return { rows, skipped };
}
