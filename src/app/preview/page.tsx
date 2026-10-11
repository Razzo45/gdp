'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { OfficeViewer } from '@/components/OfficeViewer';

function PreviewBody() {
  const params = useSearchParams();
  const src = params.get('src') ?? '';
  const name = params.get('name') ?? 'File';
  const ext = (params.get('ext') ?? '').toLowerCase();
  const kind = ext === 'pptx' || ext === 'docx' || ext === 'xlsx' || ext === 'csv' ? ext : null;

  return (
    <div className="flex h-dvh flex-col bg-zinc-100 text-zinc-900">
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2">
        <strong className="min-w-0 truncate">{name}</strong>
        {src && (
          <a className="ml-auto text-sm font-semibold text-indigo-600" href={`${src}${src.includes('?') ? '&' : '?'}download=1`}>
            Download
          </a>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {!src || !kind ? <p className="p-6 text-sm text-zinc-600">Nothing to preview.</p> : <OfficeViewer href={src} ext={kind} />}
      </div>
    </div>
  );
}

export default function PreviewPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Opening…</p>}>
      <PreviewBody />
    </Suspense>
  );
}
