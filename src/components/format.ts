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

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
