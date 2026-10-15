/** Formatting shared by server and client components (no directives). */

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Parse an ISO-ish stamp as an instant. Datetimes with no zone are UTC — Node (UTC) and the browser (local) otherwise disagree and that hydration miss reloads the page. */
function instant(iso: string): Date {
  const trimmed = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed)) {
    return new Date(`${trimmed.replace(' ', 'T')}Z`);
  }
  return new Date(trimmed);
}

/** Fixed UTC stamp — never `toLocaleString` (Node vs browser / ICU spaces). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = instant(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** How the team names a task: the first 8 of the Catalog submission id. */
export function shortCatalogId(catalogSubmissionId: string | null | undefined): string {
  const id = catalogSubmissionId?.trim() ?? '';
  return id ? id.slice(0, 8) : '—';
}

/** Board rows stay one line. Longer Catalog hero copy starts collapsed. */
export const BOARD_HERO_WORDS = 10;

export function clipWords(text: string, limit = BOARD_HERO_WORDS): { preview: string; collapsed: boolean } {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return { preview: '', collapsed: false };
  const words = trimmed.split(' ');
  if (words.length <= limit) return { preview: trimmed, collapsed: false };
  return { preview: `${words.slice(0, limit).join(' ')}…`, collapsed: true };
}

const ROLE_OPENER = /^(?:hi,?\s+)?i(?:'m| am)\s+/i;
const ASKED =
  /(?:tasked with|asked to|need help|looking to)\s+(?:producing|creating|preparing|making|designing|building|writing|developing|produce|create|prepare|make|design|build|write|develop)\s+/i;
const DOING = /\b(?:producing|creating|preparing|making|designing|building|writing|developing)\s+(?=an?\s+|the\s+)/i;
const IMPERATIVE = /^(?:make|create|build|produce|write|design|prepare|develop)\s+/i;

function clipPhrase(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function firstPhrase(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const clause = text.search(/\s+(?:that|which|so that|who|where)\s+/i);
  if (clause > 12) text = text.slice(0, clause);
  const stop = text.search(/[.!?]/);
  if (stop > 8) text = text.slice(0, stop);
  text = text.replace(/[:;,]+\s*$/g, '').trim();
  text = text.replace(/^(?:an?|the)\s+/i, '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function orgOf(text: string): string | null {
  const match = text.match(/\bat\s+([A-Z][\w&.''-]{1,}(?:\s+(?:and|&|[A-Z][\w&.''-]{1,}))*)/);
  const org = match?.[1]?.trim() ?? '';
  return org.length >= 3 ? org : null;
}

function deliverableOf(text: string): string | null {
  const labeled = text.match(/^(?:deliverable|task)\s*:\s*(.+)$/i);
  if (labeled) return firstPhrase(labeled[1] ?? '') || null;
  for (const pattern of [ASKED, IMPERATIVE, DOING]) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    const phrase = firstPhrase(text.slice(match.index + match[0].length));
    if (phrase) return phrase;
  }
  return null;
}

/** One-line cliff notes under the short id — not the first-person Catalog prompt. */
export function shortTaskDescriptor(title: string | null | undefined, max = 72): string {
  const text = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return '';
  const deliverable = deliverableOf(text);
  const org = orgOf(text);
  let phrase = deliverable;
  if (phrase && org && !phrase.toLowerCase().includes(org.toLowerCase())) phrase = `${phrase} for ${org}`;
  if (!phrase && !ROLE_OPENER.test(text) && text.length <= max) return text.replace(/[.,;:]+$/, '');
  if (!phrase) phrase = firstPhrase(text.replace(ROLE_OPENER, '')) || text;
  return clipPhrase(phrase, max);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
