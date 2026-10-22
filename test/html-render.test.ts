import { describe, expect, it } from 'vitest';
import { allowedRenderUrl, safeRelativePath } from '@/domain/htmlRender';

const ROOT = 'file:///tmp/gdp-html-abc/';

describe('allowedRenderUrl', () => {
  it('lets the page load its own folder and the public web', () => {
    expect(allowedRenderUrl('file:///tmp/gdp-html-abc/css/site.css', ROOT)).toBe(true);
    expect(allowedRenderUrl('https://unpkg.com/three@0.160.0/build/three.module.js', ROOT)).toBe(true);
    expect(allowedRenderUrl('https://fonts.gstatic.com/s/inter.woff2', ROOT)).toBe(true);
    expect(allowedRenderUrl('data:image/png;base64,AAAA', ROOT)).toBe(true);
  });

  it('blocks the rest of the disk, our private network and cloud metadata', () => {
    expect(allowedRenderUrl('file:///etc/passwd', ROOT)).toBe(false);
    expect(allowedRenderUrl('file:///tmp/gdp-html-abcd/other.html', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://postgres.railway.internal:5432', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://localhost:8080/api/health', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://169.254.169.254/latest/meta-data', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://10.0.0.5/', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://192.168.1.1/', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://172.20.0.1/', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://[::1]/', ROOT)).toBe(false);
    expect(allowedRenderUrl('http://worker/', ROOT)).toBe(false);
    expect(allowedRenderUrl('ws://example.com/', ROOT)).toBe(false);
  });
});

describe('safeRelativePath', () => {
  it('keeps archive paths inside the render folder', () => {
    expect(safeRelativePath('site/css/main.css')).toBe('site/css/main.css');
    expect(safeRelativePath('./index.html')).toBe('index.html');
    expect(safeRelativePath('../escape.html')).toBeNull();
    expect(safeRelativePath('C:/Windows/win.ini')).toBeNull();
  });
});
