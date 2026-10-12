import { toAffirmativeStatement } from './lint';
import { correctTag, RUBRIC_TAGS, type RubricTag } from './rubric';

/**
 * Parses pasted text into statements. One per line; an optional leading
 * `Tag |` or `Tag:` picks the tag; questions become affirmatives;
 * blank lines, numbering and bullets are ignored.
 */
const TAG_INDEX = new Map(RUBRIC_TAGS.map((t) => [t.toLowerCase().replace(/[^a-z]/g, ''), t]));

function splitPasteLine(rawLine: string): { line: string; suggestedTag: RubricTag | null } {
  let line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)]|s\d{3}[:.)])\s*/i, '').trim();
  let suggestedTag: RubricTag | null = null;
  const split = line.match(/^([^|:]{3,40})\s*[|:]\s*(.+)$/);
  if (split) {
    const found = TAG_INDEX.get(split[1]!.toLowerCase().replace(/[^a-z]/g, ''));
    if (found) {
      suggestedTag = found;
      line = split[2]!.trim();
    }
  }
  return { line, suggestedTag };
}

/** One statement per line. A `Tag |` prefix is a suggestion only — the creator still picks the tag. */
export function parsePasteLines(text: string): { rows: { statement: string; suggestedTag: RubricTag | null }[]; skipped: string[] } {
  const rows: { statement: string; suggestedTag: RubricTag | null }[] = [];
  const skipped: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const { line, suggestedTag } = splitPasteLine(rawLine);
    const statement = toAffirmativeStatement(line);
    if (statement.length < 8 || statement.length > 600) {
      skipped.push(rawLine.trim());
      continue;
    }
    rows.push({ statement, suggestedTag });
  }
  return { rows, skipped };
}

export function parseImport(text: string): { rows: { tag: RubricTag; statement: string }[]; skipped: string[] } {
  const parsed = parsePasteLines(text);
  return {
    skipped: parsed.skipped,
    rows: parsed.rows.map((row) => ({
      tag: correctTag(row.statement, row.suggestedTag ?? 'Content - Semantics'),
      statement: row.statement,
    })),
  };
}
