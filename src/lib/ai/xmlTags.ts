/** OOXML tags often carry a prefix (`w:p`, `x:row`). Match the local name either way. */

export function nsOpen(name: string): string {
  return `<(?:[A-Za-z_][\\w.-]*:)?${name}(?=[\\s>/])`;
}

export function nsClose(name: string): string {
  return `<\\/(?:[A-Za-z_][\\w.-]*:)?${name}>`;
}

export function nsTexts(xml: string, name: string): string[] {
  const re = new RegExp(`${nsOpen(name)}[^>]*>([^<]*)${nsClose(name)}`, 'g');
  const out: string[] = [];
  for (const match of xml.matchAll(re)) {
    const text = decodeXml(match[1] ?? '');
    if (text) out.push(text);
  }
  return out;
}

export function nsInners(xml: string, name: string): { attrs: string; inner: string }[] {
  const re = new RegExp(`${nsOpen(name)}([^>]*?)(?:\\/>|>([\\s\\S]*?)${nsClose(name)})`, 'g');
  const out: { attrs: string; inner: string }[] = [];
  for (const match of xml.matchAll(re)) out.push({ attrs: match[1] ?? '', inner: match[2] ?? '' });
  return out;
}

export function nsAttr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}
