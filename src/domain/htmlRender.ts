/**
 * Which requests an HTML deliverable may make while the worker screenshots it.
 * Public web (CDN scripts, fonts, images) and its own folder are allowed; our
 * private network, cloud metadata and the rest of the disk are not.
 */
export function allowedRenderUrl(raw: string, rootUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.protocol === 'file:') return url.href.startsWith(rootUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return publicHost(url.hostname);
}

function publicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!name.includes('.') && !name.includes(':')) return false;
  if (/(^|\.)(localhost|internal|local|lan|home|corp)$/.test(name) || name.endsWith('.railway.internal')) return false;
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (name.includes(':')) return !(name === '::1' || name === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(name) || name.startsWith('::ffff:'));
  return true;
}

/** Keeps archive entry paths inside the render folder. */
export function safeRelativePath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..' || /^[a-z]:$/i.test(part))) return null;
  return parts.join('/');
}
