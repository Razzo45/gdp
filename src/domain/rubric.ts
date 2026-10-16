import { describeNamedFiles } from './fileLanguage';

/**
 * The rubric contract. Pure; shared by server, worker and browser.
 *
 * A statement is an affirmative Precise Boolean: "Yes" means the desired
 * state holds. Polarity is never configurable — the factory rejects
 * negative-as-desired wording and the lint flags it.
 */
export const FAMILIES = ['format', 'content', 'visual'] as const;
export type Family = (typeof FAMILIES)[number];

export type TagStyle = 'visual' | 'craft';

export const FAMILY_LABELS: Record<Family, string> = {
  format: 'Format/File',
  content: 'Content',
  visual: 'Visual',
};

export function familyLabels(style: TagStyle): Record<Family, string> {
  return { format: 'Format/File', content: 'Content', visual: style === 'craft' ? 'Craft' : 'Visual' };
}

export const RUBRIC_TAGS = [
  'Format/File',
  'Content - Exact',
  'Content - Structural',
  'Content - Semantics',
  'Content - Quantitative',
  'Visual - Branding',
  'Visual - Layout',
  'Visual - Consistency',
  'Visual - Balance/Density',
  'Visual - Language & Readability',
  'Craft - Branding',
  'Craft - Composition',
  'Craft - Consistency',
  'Craft - Balance',
  'Craft - Clarity',
] as const;
export type RubricTag = (typeof RUBRIC_TAGS)[number];

export const TAG_FAMILY: Record<RubricTag, Family> = {
  'Format/File': 'format',
  'Content - Exact': 'content',
  'Content - Structural': 'content',
  'Content - Semantics': 'content',
  'Content - Quantitative': 'content',
  'Visual - Branding': 'visual',
  'Visual - Layout': 'visual',
  'Visual - Consistency': 'visual',
  'Visual - Balance/Density': 'visual',
  'Visual - Language & Readability': 'visual',
  'Craft - Branding': 'visual',
  'Craft - Composition': 'visual',
  'Craft - Consistency': 'visual',
  'Craft - Balance': 'visual',
  'Craft - Clarity': 'visual',
};

const TO_CRAFT: Record<string, RubricTag> = {
  'Visual - Branding': 'Craft - Branding',
  'Visual - Layout': 'Craft - Composition',
  'Visual - Consistency': 'Craft - Consistency',
  'Visual - Balance/Density': 'Craft - Balance',
  'Visual - Language & Readability': 'Craft - Clarity',
};
const TO_VISUAL: Record<string, RubricTag> = {
  'Craft - Branding': 'Visual - Branding',
  'Craft - Composition': 'Visual - Layout',
  'Craft - Consistency': 'Visual - Consistency',
  'Craft - Balance': 'Visual - Balance/Density',
  'Craft - Clarity': 'Visual - Language & Readability',
};

export function tagStyleOf(input: { tags?: readonly string[]; hasCurrentRubric?: boolean }): TagStyle {
  if ((input.tags ?? []).some((tag) => tag.startsWith('Craft - '))) return 'craft';
  if (input.hasCurrentRubric) return 'visual';
  return 'craft';
}

/** Full Generate / Regenerate. Current Visual seats do not keep the factory on Visual. */
export function tagStyleForGenerate(_current?: { tags?: readonly string[]; hasCurrentRubric?: boolean }): TagStyle {
  return 'craft';
}

export function tagsForStyle(style: TagStyle): RubricTag[] {
  const family = style === 'craft'
    ? (['Craft - Branding', 'Craft - Composition', 'Craft - Consistency', 'Craft - Balance', 'Craft - Clarity'] as const)
    : (['Visual - Branding', 'Visual - Layout', 'Visual - Consistency', 'Visual - Balance/Density', 'Visual - Language & Readability'] as const);
  return ['Format/File', 'Content - Exact', 'Content - Structural', 'Content - Semantics', 'Content - Quantitative', ...family];
}

export function aliasTag(tag: string, style: TagStyle): RubricTag | null {
  if (style === 'craft' && TO_CRAFT[tag]) return TO_CRAFT[tag]!;
  if (style === 'visual' && TO_VISUAL[tag]) return TO_VISUAL[tag]!;
  return isRubricTag(tag) ? tag : null;
}

export function familyOfTag(tag: string): Family {
  return TAG_FAMILY[tag as RubricTag] ?? 'content';
}

export function isRubricTag(tag: string): tag is RubricTag {
  return (RUBRIC_TAGS as readonly string[]).includes(tag);
}

const WORD_COUNT = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';

/**
 * File/delivery claims belong in Format even when the model tagged them
 * Content. Content is what the work says; Format is the container.
 */
export function guessTag(statement: string, style: TagStyle = 'visual'): RubricTag {
  const q = describeNamedFiles(statement).toLowerCase();
  let tag: RubricTag = 'Content - Semantics';
  if (isFormatClaim(q)) tag = 'Format/File';
  else if (isTypefaceClaim(q) || /\b(hex|#|logo|crest|lockup|brand(?:ing)?|palette|color|colour|font style|font size|typography|wordmark|typefaces?|fonts?|visual design)\b/.test(q)) tag = 'Visual - Branding';
  else if (/\b(hierarchy|header|subheader|titles?|subtitle|placement|layout|space|breathe|bleed|lower-thirds?|graphic cards?|camera movement|handheld|shaky-cam|drone shot|aerial|b-roll|medium shot|close-up|close up|opens with|places the shot|shots? of)\b/.test(q)) tag = 'Visual - Layout';
  else if (/\b(consistent|similar across|same brand|connected|lip movements?|wardrobe|headshot|on-camera presenter|sunglasses|polo shirt)\b/.test(q)) tag = 'Visual - Consistency';
  else if (/\b(pixelat|legib|read on a mobile|morph artifacts?|melting faces?|facial distortion|conversational pace|visual footage|visual effects|visual treatment|visual detail|visual motion|motion graphics|natural imagery|natural texture)\b/.test(q)) tag = 'Visual - Language & Readability';
  else if (/\b(matte|occlusion|keying|halos?|fringes?|chatter|buzzing|composite|foreground alpha|silhouettes?|spatial (?:drift|sliding)|cutout seams?|lens blur|optical (?:glow|focus)|rim lighting|film grain|image noise|desaturated|glow bloom|dense opacity|billowing|luminous highlight|highlight detail|impact flash|diffused outer edges)\b/.test(q)) {
    tag = 'Visual - Language & Readability';
  } else if (/\bprovided in the input files\b/.test(q) || /\breference landscape style\b/.test(q)) tag = 'Visual - Branding';
  else if (/\bremain completely static\b/.test(q) && /\bconsecutive frames\b/.test(q)) tag = 'Visual - Consistency';
  else if (/\b(drop shadows?|gradient fills?|3d extrusion|bevels?|arial|background fills?|slide canvas|overlap or collide|numerical scales|slide number|solid fills?|playable audio|audio media object|fully legible|closing section|source note|competitive phrasing|winning language)\b/.test(q)) {
    tag = 'Visual - Layout';
  } else if (/\b(exactly as written|spell|caption|copy read|words spelled)\b/.test(q)) tag = 'Content - Exact';
  else if (/\b(\d+|three|two|one)\b/.test(q) && /\b(posts?|mockups?|images?)\b/.test(q)) tag = 'Content - Quantitative';
  return aliasTag(tag, style) ?? tag;
}

/** Imported Format tags are untrusted — a cited .png/.pptx is not a file-type claim. */
export function reseatImportedTag(statement: string, storedTag?: string): RubricTag {
  const suggested = storedTag && isRubricTag(storedTag) && storedTag !== 'Format/File' ? storedTag : undefined;
  return correctTag(statement, suggested);
}

function tagInFamily(family: Family, statement: string, style: TagStyle = 'visual'): RubricTag {
  const guessed = guessTag(statement, style);
  if (familyOfTag(guessed) === family) return guessed;
  if (family === 'format') return 'Format/File';
  if (family === 'visual') return style === 'craft' ? 'Craft - Composition' : 'Visual - Layout';
  return 'Content - Semantics';
}

/**
 * Move only surplus seats (usually dumped Format) onto families that are
 * short of quota. Seats already in a family at or under quota stay put.
 */
export function reseatOverQuotaFamilies<T extends { family: Family; tag: string; statement: string }>(
  rows: readonly T[],
  quotas: Record<Family, number> = { format: 5, content: 15, visual: 30 },
): T[] {
  const style = tagStyleOf({ tags: rows.map((row) => row.tag), hasCurrentRubric: true });
  const current = rows.map((row) => ({ ...row, family: seatedFamily(row) }));
  const counts = countFamilies(current);
  const extra: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  const missing: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  for (const family of FAMILIES) {
    extra[family] = Math.max(0, counts[family] - quotas[family]);
    missing[family] = Math.max(0, quotas[family] - counts[family]);
  }
  if (FAMILIES.every((family) => extra[family] === 0)) return current;

  const formatKeepScore = (statement: string): number => {
    const q = describeNamedFiles(statement).toLowerCase();
    return isFormatClaim(q) ? 100 : 0;
  };
  const contentKeepScore = (statement: string): number => {
    const q = describeNamedFiles(statement).toLowerCase();
    if (/\b(dialogue|script|spoken|voiceover|narrative)\b/.test(q)) return 2;
    if (/\b(music|audio track|mixed underneath)\b/.test(q)) return 1;
    return 0;
  };
  const destFor = (statement: string): Family => {
    const guessed = familyOfTag(guessTag(statement));
    if (missing[guessed] > 0) return guessed;
    const prefer: Family[] = ['content', 'visual', 'format'];
    return prefer.find((family) => missing[family] > 0) ?? guessed;
  };

  const movePriority = (statement: string): number => {
    const guessed = familyOfTag(guessTag(statement));
    if (guessed === 'visual' && missing.visual > 0) return 100;
    if (guessed === 'content' && missing.content > 0) return 50 + contentKeepScore(statement);
    if (guessed === 'content') return 10 + contentKeepScore(statement);
    return 0;
  };

  const next = current.map((row) => ({ ...row }));
  for (const family of FAMILIES) {
    if (extra[family] === 0) continue;
    const seats = next.map((row, index) => ({ row, index })).filter(({ row }) => row.family === family);
    const strong = seats.filter(({ row }) => (family === 'format' ? formatKeepScore(row.statement) > 0 : false));
    const weak = seats
      .filter((seat) => !strong.includes(seat))
      .sort((a, b) => movePriority(b.row.statement) - movePriority(a.row.statement) || a.index - b.index);
    const keepWeak = Math.max(0, quotas[family] - strong.length);
    const surplus = weak.slice(0, Math.max(0, weak.length - keepWeak));
    for (const { row, index } of surplus) {
      const dest = destFor(row.statement);
      if (dest === row.family || missing[dest] <= 0) continue;
      missing[dest] -= 1;
      extra[family] -= 1;
      next[index] = { ...row, family: dest, tag: tagInFamily(dest, row.statement, style) };
    }
  }
  return next;
}

export function familyWord(style: TagStyle): string {
  return familyLabels(style).visual;
}

export function quotaCaption(style: TagStyle = 'visual'): string {
  return `5 Format, 15 Content, 30 ${familyWord(style)}`;
}

export function correctTag(statement: string, suggested?: string, style?: TagStyle): RubricTag {
  const channel = style ?? (suggested?.startsWith('Craft - ') ? 'craft' : 'visual');
  const inferred = guessTag(statement, channel);
  if (inferred === 'Format/File') return inferred;
  if (isTypefaceClaim(statement.toLowerCase()) && (!suggested || familyOfTag(suggested) === 'content')) {
    return channel === 'craft' ? 'Craft - Branding' : 'Visual - Branding';
  }
  if (suggested && isRubricTag(suggested)) return aliasTag(suggested, channel) ?? suggested;
  return inferred;
}

/** Creator seating wins. Factory/import still use correctTag to steal Format from untrusted tags. */
export function honorSeatedTag(statement: string, chosen?: string): RubricTag {
  if (chosen && isRubricTag(chosen)) return chosen;
  return correctTag(statement);
}

export function familyOfStatement(statement: string, tag?: string): Family {
  return familyOfTag(correctTag(statement, tag));
}

/** Family the seat was stored under. Do not re-guess for quota / section checks. */
export function seatedFamily(row: { family?: Family | null; tag?: string; statement?: string }): Family {
  if (row.family && (FAMILIES as readonly string[]).includes(row.family)) return row.family;
  if (row.tag && isRubricTag(row.tag)) return familyOfTag(row.tag);
  return familyOfStatement(row.statement ?? '', row.tag);
}

function isFormatClaim(q: string): boolean {
  if (/\b(pptx|docx|xlsx|pdf|csv)\s+format\b/.test(q)) return true;
  if (/\b(in|as)\s+(a\s+|an\s+)?(pptx|docx|xlsx|pdf|csv)\b/.test(q)) return true;
  if (/\b(delivered|exported|saved|encoded|output)\b[\s\S]{0,40}\b(as|in)\b[\s\S]{0,20}\b\.?(png|jpe?g|webp|pptx|docx|xlsx|pdf|csv|wav|mp4)\b/.test(q)) return true;
  if (/\bas a \.?(png|jpe?g|webp|pptx|docx|xlsx|pdf|csv)\s+file\b/.test(q)) return true;
  if (/\b(png|jpe?g|webp|pptx|docx|xlsx|pdf|csv)\s+(file|format)\b/.test(q)) return true;
  if (/\b(is|as)\s+an?\s+editable\b/.test(q)) return true;
  if (/\b(powerpoint|word document|excel (?:file|workbook)|spreadsheet)\b/.test(q) && /\b(format|file type|editable|deliverable)\b/.test(q)) return true;
  if (/\b(file type|file format|file extension|file name|filename|embedded fonts?|fonts? embedded)\b/.test(q)) return true;
  if (/\b(\d+\s*px|1080|1920|3840|2160|4k|1:1|16:9|4:3|widescreen|page size|slide size|full bleed|carousel image)\b/.test(q)) return true;
  if (/\bframes per second\b|\b\d+\s*fps\b/.test(q)) return true;
  if (/\b\d{3,5}\s*[x×]\s*\d{3,5}\s*pixels?\b/.test(q)) return true;
  if (/\baspect ratio\b/.test(q) && !/\b(logo|icon|lockup|wordmark|graphic|mark)\b/.test(q)) return true;
  if (new RegExp(`\\b(exactly |contains? |total of )?(\\d+|${WORD_COUNT})[-\\s]+(slides?|pages?|sheets?)\\b`).test(q) && /\b(exactly|contains?|between|total)\b/.test(q)) return true;
  if (/\bbetween\s+\d+\s+and\s+\d+\b/.test(q) && /\b(slides?|pages?|sheets?)\b/.test(q)) return true;
  if (/\b(slide|page|sheet)\s+(count|total)\b|\btotal slides\b/.test(q)) return true;
  if (/\b(corruption|repair warnings?)\b/.test(q)) return true;
  if (/\b(files?|images?)\b/.test(q) && /\bincluded\b/.test(q) && /\b(output|export|deliverable)\b/.test(q)) return true;
  if (/\brec\.?709\b/.test(q) || /\bcolor space encoding\b/.test(q)) return true;
  if (/\b(runtime|duration)\b/.test(q) && /\b\d+:\d+|\b\d+\s*seconds?\b|\b\d+\s*frames?\b/.test(q)) return true;
  if (/\b(audio streams?|silent audio)\b/.test(q)) return true;
  if (/\b(quicktime|\.mov\b|mov file|prores|4444)\b/.test(q)) return true;
  return false;
}

/** Named typeface is brand/look. Embedded fonts are a file property (Format). */
function isTypefaceClaim(q: string): boolean {
  if (/\b(embedded fonts?|fonts? embedded)\b/.test(q)) return false;
  return /\bfont famil/.test(q) || /\btypefaces?\b/.test(q) || /\buses the \S+(?:\s+\S+)? font(?: family)?\b/.test(q);
}

/** Standard target and the 10% / 30% / 60% family split (5 / 15 / 30 at 50). */
export const RUBRIC_TARGET = 50;
export const RUBRIC_MIN = 40;

/** Upper bound on seeds extracted from notes (one enhancer call each). */
export const MAX_SEEDS = 100;
export const MAX_SEED_CHARS = 600;
/** Pasted notes / question lists. Every distinct check becomes a seed (capped at MAX_SEEDS). */
export const MAX_ROUGH_CHARS = 50_000;

export function familyQuotas(n: number = RUBRIC_TARGET): Record<Family, number> {
  const format = Math.max(3, Math.round((n * 5) / 50));
  const content = Math.max(10, Math.round((n * 15) / 50));
  let visual = n - format - content;
  if (visual < 18) {
    const bump = 18 - visual;
    const fromContent = Math.min(bump, Math.max(0, content - 10));
    visual += fromContent;
    return { format, content: content - fromContent, visual };
  }
  return { format, content, visual };
}

function familyShort(style: TagStyle): Record<Family, string> {
  return { format: 'Format', content: 'Content', visual: familyWord(style) };
}

export function countFamilies(rows: readonly { family?: Family | null; tag?: string; statement?: string }[]): Record<Family, number> {
  const counts: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  for (const row of rows) counts[seatedFamily(row)] += 1;
  return counts;
}

export function quotaSpread(
  counts: Record<Family, number>,
  quotas: Record<Family, number> = familyQuotas(),
  style: TagStyle = 'visual',
): {
  ready: boolean;
  missing: Record<Family, number>;
  extra: Record<Family, number>;
  canAdd: Record<Family, boolean>;
  warning: string;
} {
  const missing: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  const extra: Record<Family, number> = { format: 0, content: 0, visual: 0 };
  const canAdd: Record<Family, boolean> = { format: false, content: false, visual: false };
  const parts: string[] = [];
  const short = familyShort(style);
  for (const family of FAMILIES) {
    const have = counts[family] ?? 0;
    const want = quotas[family] ?? 0;
    missing[family] = Math.max(0, want - have);
    extra[family] = Math.max(0, have - want);
    canAdd[family] = have < want;
    if (missing[family] > 0) parts.push(`${short[family]} short by ${missing[family]} (${have} of ${want})`);
    else if (extra[family] > 0) parts.push(`${short[family]} has ${have} of ${want}`);
  }
  return { ready: parts.length === 0, missing, extra, canAdd, warning: parts.length ? `${parts.join('. ')}.` : '' };
}

export type StatementScope = 'output' | 'inputs';

/** The editable shape of one seat. Mirrors app.rubric_statements. */
export interface StatementDraft {
  id: string;
  position: number;
  family: Family;
  tag: string;
  statement: string;
  notes: string;
  scope: StatementScope;
  inputFileIds: string[];
  outputFile: string | null;
  claimKey: string | null;
}

/** Delivered row id: `s001`, `s002`, … in display order. */
export const deliveryId = (index: number): string => `s${String(index + 1).padStart(3, '0')}`;

const FAMILY_DISPLAY: Family[] = ['format', 'content', 'visual'];

export interface SeatRef {
  id: string;
  family?: Family;
  tag?: string;
  position?: number;
  statement?: string;
}

function familyOfSeat(row: SeatRef): Family {
  return seatedFamily(row);
}

/** Format 1–5, Content 6–20, Visual 21–50 — one number the whole team shares. */
export function seatsInDisplayOrder<T extends SeatRef>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const fa = FAMILY_DISPLAY.indexOf(familyOfSeat(a));
    const fb = FAMILY_DISPLAY.indexOf(familyOfSeat(b));
    if (fa !== fb) return fa - fb;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

export function seatIndexById(rows: readonly SeatRef[]): Map<string, number> {
  const map = new Map<string, number>();
  seatsInDisplayOrder(rows).forEach((row, index) => map.set(row.id, index + 1));
  return map;
}

export function seatLabel(n: number | undefined): string {
  return typeof n === 'number' && n > 0 ? `Seat ${n}` : 'Seat';
}

/** Swap raw statement ids (uuid or s001) in operator-facing copy for "Seat 8". */
export function withSeatLabels(text: string, seats: Map<string, number>): string {
  let out = text;
  for (const [id, n] of seats) {
    if (id && out.includes(id)) out = out.split(id).join(seatLabel(n));
    const delivered = deliveryId(n - 1);
    if (out.includes(delivered)) out = out.split(delivered).join(seatLabel(n));
  }
  return out;
}
