import 'server-only';

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowedRenderUrl, safeRelativePath } from '@/domain/htmlRender';
import { env } from '@/lib/env';

export interface HtmlShot {
  view: 'desktop' | 'mobile';
  mime: 'image/jpeg';
  bytes: Uint8Array;
}

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };
export const MAX_PAGE_HEIGHT = 4_500;
const SETTLE_MS = 3_000;
const LOAD_TIMEOUT_MS = 20_000;

let browserPath: Promise<string | null> | null = null;
let active = 0;
const waiting: (() => void)[] = [];

function chromiumPath(): Promise<string | null> {
  browserPath ??= (async () => {
    const candidates = [
      env().CHROMIUM_BIN,
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter((path): path is string => Boolean(path));
    for (const path of candidates) {
      if (await access(path).then(() => true, () => false)) return path;
    }
    return null;
  })();
  return browserPath;
}

/**
 * Screenshots an HTML deliverable the way a person would first see it: a
 * desktop page (capped height) and a phone's first screen. Siblings are the
 * other files of the same archive so relative CSS, scripts and images load.
 * Returns [] when no browser is installed or the page will not render.
 */
export async function screenshotHtml(input: { name: string; bytes: Uint8Array; siblings?: { name: string; bytes: Uint8Array }[] }): Promise<HtmlShot[]> {
  const executablePath = await chromiumPath();
  if (!executablePath) return [];
  if (active >= 1) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  const dir = await mkdtemp(join(tmpdir(), 'gdp-html-'));
  const { chromium } = await import('playwright-core');
  const browser = await chromium
    .launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] })
    .catch(() => null);
  try {
    if (!browser) return [];
    for (const sibling of input.siblings ?? []) {
      const path = safeRelativePath(sibling.name);
      if (!path) continue;
      const full = join(/* turbopackIgnore: true */ dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, sibling.bytes);
    }
    const entryPath = join(/* turbopackIgnore: true */ dir, safeRelativePath(input.name) ?? 'index.html');
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, input.bytes);
    const root = pathToFileURL(dir + '/').href;
    const target = pathToFileURL(entryPath).href;

    const shoot = async (view: HtmlShot['view']): Promise<HtmlShot | null> => {
      const size = view === 'desktop' ? DESKTOP : MOBILE;
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, isMobile: view === 'mobile', hasTouch: view === 'mobile' });
      try {
        await context.route('**/*', (route) => (allowedRenderUrl(route.request().url(), root) ? route.continue() : route.abort()));
        const page = await context.newPage();
        await page.goto(target, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(SETTLE_MS);
        const height = view === 'desktop' ? await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)) : size.height;
        const bytes = await page.screenshot({
          type: 'jpeg',
          quality: 72,
          ...(view === 'desktop' ? { fullPage: true, clip: { x: 0, y: 0, width: size.width, height: Math.max(size.height, Math.min(height, MAX_PAGE_HEIGHT)) } } : {}),
          timeout: LOAD_TIMEOUT_MS,
        });
        return { view, mime: 'image/jpeg', bytes: new Uint8Array(bytes) };
      } catch {
        return null;
      } finally {
        await context.close().catch(() => undefined);
      }
    };

    const shots: HtmlShot[] = [];
    for (const view of ['desktop', 'mobile'] as const) {
      const shot = await shoot(view);
      if (shot) shots.push(shot);
    }
    return shots;
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    active -= 1;
    waiting.shift()?.();
  }
}
