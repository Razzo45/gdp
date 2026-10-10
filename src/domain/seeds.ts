import { INTERROGATIVE_OPENER, toAffirmativeStatement } from './lint';
import { MAX_SEED_CHARS, MAX_SEEDS, isRubricTag, type RubricTag } from './rubric';

/**
 * Pipeline: collect every distinct expert check → expand each into a candidate
 * bank → assemble seats the best rows into the rubric. Never collapse a list
 * of checks into a handful of themes.
 */

export interface ExtractedSeed {
  theme: string;
  statement: string;
  tag: RubricTag;
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|s\d{3}[:.)])\s*/i;

/** Numbered / bulleted lines the operator already wrote as checks. */
export function looksLikeSeedList(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => LIST_ITEM.test(line)).length >= 3;
}

function looksLikeHeading(line: string): boolean {
  const text = line.trim().replace(/:$/, '');
  if (!text) return true;
  if (/\?\s*$/.test(text) || INTERROGATIVE_OPENER.test(text)) return false;
  if (/\d|#|px\b|hex\b|\.png|\.jpe?g|\.webp|\.pptx|\.pdf/i.test(text)) return false;
  const words = text.split(/\s+/);
  return words.length <= 5 && !/\b(include|included|provided|using|use|show|shows|display|spell|avoid|utilize|incorporate|aligned|created|delivered|written|resemble|label)\b/i.test(text);
}

export function guessTag(statement: string): RubricTag {
  const q = statement.toLowerCase();
  if (/\b(\d+\s*px|1080|ratio|1:1|16:9|\.png|\.jpe?g|rgb|file|files|full bleed|carousel image)\b/.test(q)) return 'Format/File';
  if (/\b(hex|#|logo|brand|josefin|palette|color|colour|font style|typography)\b/.test(q)) return 'Visual - Branding';
  if (/\b(hierarchy|header|subheader|title|subtitle|placement|layout|space|breathe|bleed)\b/.test(q)) return 'Visual - Layout';
  if (/\b(consistent|similar across|same brand|connected)\b/.test(q)) return 'Visual - Consistency';
  if (/\b(pixelat|legib|read on a mobile|font size)\b/.test(q)) return 'Visual - Language & Readability';
  if (/\b(exactly as written|spell|caption|copy read|words spelled)\b/.test(q)) return 'Content - Exact';
  if (/\b(\d+|three|two|one)\b/.test(q) && /\b(files?|posts?|mockups?|images?)\b/.test(q)) return 'Content - Quantitative';
  return 'Content - Semantics';
}

/**
 * Pull every distinct check out of pasted notes. Section headings become
 * themes; questions become affirmative seed statements. Caps at MAX_SEEDS.
 */
export function extractSeedsFromNotes(text: string, max: number = MAX_SEEDS): ExtractedSeed[] {
  const seeds: ExtractedSeed[] = [];
  const seen = new Set<string>();
  let theme = 'General';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(LIST_ITEM, '').trim();
    if (!line) continue;
    if (looksLikeHeading(line)) {
      theme = line.replace(/:$/, '').trim() || theme;
      continue;
    }
    let body = line;
    let tag: RubricTag | undefined;
    const tagged = line.match(/^([^|:]{3,40})\s*[|:]\s*(.+)$/);
    if (tagged && isRubricTag(tagged[1]!.trim())) {
      tag = tagged[1]!.trim() as RubricTag;
      body = tagged[2]!.trim();
    }
    const statement = toAffirmativeStatement(body);
    if (statement.length < 8 || statement.length > MAX_SEED_CHARS) continue;
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ theme: theme.slice(0, 80), statement, tag: tag ?? guessTag(statement) });
    if (seeds.length >= max) break;
  }
  return seeds;
}

/** How many bank rows the enhancer should aim for from one seed. */
export function enhancerRowsPerSeed(seedCount: number, target: number): number {
  return Math.min(40, Math.max(3, Math.ceil((target * 3) / Math.max(1, seedCount))));
}

export function shouldExtractNotes(notes: string): boolean {
  const extracted = extractSeedsFromNotes(notes);
  if (extracted.length === 0) return false;
  return looksLikeSeedList(notes) || extracted.length >= 5;
}
