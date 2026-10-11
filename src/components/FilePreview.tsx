'use client';

import { useState } from 'react';
import { OfficeViewer } from './OfficeViewer';

export interface PreviewFile {
  id: string;
  name: string;
  mime?: string;
  extension?: string;
}

type Kind = 'image' | 'pdf' | 'office' | 'csv' | 'video' | 'audio' | 'text' | 'html' | 'opaque';
type OfficeExt = 'pptx' | 'docx' | 'xlsx' | 'csv';

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
    'text/csv': 'csv',
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
  if (ext === 'csv' || mime === 'text/csv' || mime === 'application/csv') return 'csv';
  if (['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls'].includes(ext) || mime.includes('officedocument') || mime.includes('msword') || mime.includes('ms-powerpoint') || mime.includes('ms-excel')) return 'office';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (mime.startsWith('text/') || ['txt', 'md', 'json'].includes(ext)) return 'text';
  if (mime === 'text/html' || ext === 'html') return 'html';
  return 'opaque';
}

function withParam(href: string, key: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}${key}=1`;
}

function officeExt(file: PreviewFile): OfficeExt | null {
  const ext = extOf(file);
  return ext === 'pptx' || ext === 'docx' || ext === 'xlsx' || ext === 'csv' ? ext : null;
}

export function FilePreview({ file, href }: { file: PreviewFile; href: string }) {
  const kind = kindOf(file);
  const name = displayName(file);
  const typeLabel = extOf(file).toUpperCase();
  const viewer = officeExt(file);
  const native = kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio' || kind === 'text' || kind === 'html';
  const [open, setOpen] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = !thumbFailed && (kind === 'image' || kind === 'video');

  function popOut() {
    if (viewer) {
      const query = new URLSearchParams({ src: href, name, ext: viewer });
      window.open(`/preview?${query}`, `gdp-preview-${file.id}`, 'noopener,noreferrer,width=1440,height=900');
      return;
    }
    window.open(kind === 'pdf' ? href : withParam(href, 'view'), `gdp-preview-${file.id}`, 'noopener,noreferrer,width=1440,height=900');
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {showThumb && (
        <button className="block w-full bg-wash text-left" type="button" onClick={popOut} aria-label={`Preview ${name}`}>
          <img src={withParam(href, 'thumb')} alt="" className="h-44 w-full object-contain" onError={() => setThumbFailed(true)} />
        </button>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
        <a className="min-w-0 shrink font-medium break-all hover:underline" href={withParam(href, 'download')} target="_blank" rel="noreferrer">
          {name}
        </a>
        <span className="badge badge-muted shrink-0">{typeLabel}</span>
        {(viewer || native) && (
          <button className="btn btn-sm ml-auto" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {open && (viewer || native) && (
          <button className="btn btn-sm" type="button" onClick={popOut}>
            Open window
          </button>
        )}
        {!viewer && !native && <span className="ml-auto shrink-0 text-[11px] text-muted">Download only</span>}
      </div>
      {open && viewer && <OfficeViewer href={href} ext={viewer} className="border-t border-line" />}
      {open && kind === 'pdf' && <iframe title={name} src={href} className="h-[36rem] w-full border-t border-line bg-white" />}
      {open && kind === 'image' && <img src={href} alt={name} className="max-h-[36rem] w-full border-t border-line bg-white object-contain" />}
      {open && kind === 'video' && <video src={href} controls className="max-h-[36rem] w-full border-t border-line bg-black" />}
      {open && kind === 'audio' && <audio src={href} controls className="w-full px-3 py-2" />}
      {open && (kind === 'text' || kind === 'html') && <iframe title={name} src={href} className="h-64 w-full border-t border-line bg-white" />}
    </div>
  );
}

export function FilePreviewList({ files, hrefFor, empty }: { files: PreviewFile[]; hrefFor: (file: PreviewFile) => string; empty: string }) {
  if (files.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {files.map((f) => (
        <li key={f.id}>
          <FilePreview file={f} href={hrefFor(f)} />
        </li>
      ))}
    </ul>
  );
}
