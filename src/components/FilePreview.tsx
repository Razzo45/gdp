'use client';

import { useState } from 'react';

export interface PreviewFile {
  id: string;
  name: string;
  mime?: string;
  extension?: string;
}

type Kind = 'image' | 'pdf' | 'office' | 'video' | 'audio' | 'text' | 'html' | 'opaque';

function looksLikeMime(value: string): boolean {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.trim());
}

function extOf(file: PreviewFile): string {
  const fromName = (file.name || '').split('.').pop() || '';
  const ext = (file.extension || fromName).toLowerCase().replace(/^\./, '');
  if (ext && !ext.includes('/') && ext.length <= 10) return ext;
  const mime = (file.mime ?? '').toLowerCase();
  const map: Record<string, string> = {
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/pdf': 'pdf',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.ms-excel': 'xls',
    'application/msword': 'doc',
  };
  return map[mime] || mime.split('/').pop()?.split('.').pop() || 'file';
}

function displayName(file: PreviewFile): string {
  const raw = (file.name || '').trim();
  if (raw && !looksLikeMime(raw)) return raw;
  const ext = extOf(file);
  return ext ? `file.${ext}` : 'Untitled file';
}

function kindOf(file: PreviewFile): Kind {
  const mime = (file.mime ?? '').toLowerCase();
  const ext = extOf(file);
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls'].includes(ext) || mime.includes('officedocument') || mime.includes('msword') || mime.includes('ms-powerpoint') || mime.includes('ms-excel')) return 'office';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (mime.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(ext)) return 'text';
  if (mime === 'text/html' || ext === 'html') return 'html';
  return 'opaque';
}

/**
 * Inline preview when the browser can render the type; otherwise a download
 * row. URLs are our signed/redirect routes — the Catalog token never leaves
 * the server.
 */
export function FilePreview({ file, href }: { file: PreviewFile; href: string }) {
  const kind = kindOf(file);
  const [open, setOpen] = useState(false);
  const name = displayName(file);
  const typeLabel = extOf(file).toUpperCase();

  return (
    <div className="rounded-xl border border-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
        <a className="min-w-0 shrink font-medium break-all hover:underline" href={`${href}${href.includes('?') ? '&' : '?'}download=1`} target="_blank" rel="noreferrer">
          {name}
        </a>
        <span className="badge badge-muted shrink-0">{typeLabel}</span>
        {kind !== 'opaque' && (
          <button className="btn btn-sm ml-auto" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {kind === 'opaque' && <span className="ml-auto shrink-0 text-[11px] text-muted">Download only</span>}
      </div>
      {open && kind === 'image' && <img src={href} alt={name} className="max-h-56 w-full rounded-b-xl bg-wash object-contain" />}
      {open && kind === 'pdf' && <iframe title={name} src={href} className="h-64 w-full rounded-b-xl border-t border-line bg-wash" />}
      {open && kind === 'office' && (
        <iframe title={name} src={`${href}${href.includes('?') ? '&' : '?'}preview=1`} className="h-64 w-full rounded-b-xl border-t border-line bg-wash" />
      )}
      {open && kind === 'video' && <video src={href} controls preload="metadata" className="max-h-56 w-full rounded-b-xl bg-black" />}
      {open && kind === 'audio' && <audio src={href} controls className="w-full px-3 py-2" />}
      {open && (kind === 'text' || kind === 'html') && <iframe title={name} src={href} className="h-48 w-full rounded-b-xl border-t border-line bg-surface" />}
    </div>
  );
}

export function FilePreviewList({ files, hrefFor, empty }: { files: PreviewFile[]; hrefFor: (file: PreviewFile) => string; empty: string }) {
  if (files.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {files.map((f) => (
        <li key={f.id}>
          <FilePreview file={f} href={hrefFor(f)} />
        </li>
      ))}
    </ul>
  );
}
