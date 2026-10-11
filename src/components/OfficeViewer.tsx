'use client';

import { useEffect, useRef, useState } from 'react';

type OfficeExt = 'pptx' | 'docx' | 'xlsx' | 'csv';

export function OfficeViewer({ href, ext, className = '' }: { href: string; ext: OfficeExt; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const nav = useRef<{ prev: () => Promise<void>; next: () => Promise<void>; refresh: () => void } | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const root = host.current;
    const surface = canvas.current;
    if (!root) return;
    let cancelled = false;
    let destroy: () => void = () => undefined;

    async function run(mount: HTMLElement) {
      setStatus('loading');
      setError(null);
      const response = await fetch(href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to preview this file.' : 'Could not load the file.');
      const bytes = await response.arrayBuffer();
      if (cancelled) return;

      if (ext === 'xlsx') {
        const { XlsxViewer } = await import('@silurus/ooxml/xlsx');
        const viewer = new XlsxViewer(mount);
        await viewer.load(bytes);
        destroy = () => viewer.destroy();
        setLabel('Workbook');
        return;
      }

      if (!surface) throw new Error('The preview surface is missing.');

      if (ext === 'csv') {
        const { XlsxSheetViewer } = await import('@silurus/ooxml/xlsx');
        const viewer = new XlsxSheetViewer(surface);
        await viewer.load(bytes, { format: 'csv' });
        await viewer.fitWidth();
        destroy = () => viewer.destroy();
        setLabel(viewer.sheetNames[0] || 'CSV');
        return;
      }

      if (ext === 'pptx') {
        const { PptxViewer } = await import('@silurus/ooxml/pptx');
        const viewer = new PptxViewer(surface);
        await viewer.load(bytes);
        await viewer.fitWidth();
        const refresh = () => setLabel(`Slide ${viewer.slideIndex + 1} of ${viewer.slideCount}`);
        nav.current = { prev: () => viewer.prevSlide().then(refresh), next: () => viewer.nextSlide().then(refresh), refresh };
        refresh();
        destroy = () => viewer.destroy();
        return;
      }

      const { DocxViewer } = await import('@silurus/ooxml/docx');
      const viewer = new DocxViewer(surface);
      await viewer.load(bytes);
      await viewer.fitWidth();
      const refresh = () => setLabel(`Page ${viewer.currentPage + 1} of ${viewer.pageCount}`);
      nav.current = { prev: () => viewer.prevPage().then(refresh), next: () => viewer.nextPage().then(refresh), refresh };
      refresh();
      destroy = () => viewer.destroy();
    }

    run(root)
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(caught instanceof Error ? caught.message : 'The file could not be previewed.');
      });

    return () => {
      cancelled = true;
      nav.current = null;
      destroy();
    };
  }, [href, ext]);

  const showNav = ext === 'pptx' || ext === 'docx';

  return (
    <div className={`flex flex-col bg-white text-zinc-900 ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm">
        <span className="text-zinc-600">{status === 'loading' ? 'Loading file…' : label}</span>
        {showNav && status === 'ready' && (
          <span className="ml-auto flex gap-1">
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void nav.current?.prev().then(() => tick((n) => n + 1))}
            >
              Previous
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void nav.current?.next().then(() => tick((n) => n + 1))}
            >
              Next
            </button>
          </span>
        )}
      </div>
      {status === 'error' && <p className="px-3 py-6 text-sm text-red-700">{error}</p>}
      <div ref={host} className={ext === 'xlsx' ? 'min-h-[32rem] w-full' : 'hidden'} />
      <canvas ref={canvas} className={ext === 'xlsx' ? 'hidden' : 'block w-full bg-white'} />
    </div>
  );
}
