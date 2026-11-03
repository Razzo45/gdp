'use client';

import { useState } from 'react';
import { clipWords, shortCatalogId } from './format';

/** Catalog short id on top, hero deliverable under it. */
export function TaskLabel({
  catalogId,
  hero,
  heading = false,
  size = 'board',
}: {
  catalogId: string;
  hero?: string | null;
  heading?: boolean;
  size?: 'board' | 'compact';
}) {
  const id = shortCatalogId(catalogId);
  const descriptor = hero?.replace(/\s+/g, ' ').trim() ?? '';
  if (heading) {
    return (
      <>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-[-0.025em] text-ink">{id}</h1>
          <CopyIdButton value={id} />
        </div>
        {descriptor ? <p className="mt-1 text-sm text-muted"><CollapsibleCopy text={descriptor} /></p> : null}
      </>
    );
  }
  return (
    <>
      <span className={size === 'compact' ? 'block font-mono text-sm font-semibold leading-[22px] text-ink' : 'block font-mono text-base font-semibold leading-6 tracking-[-0.01em] text-ink'}>
        {id}
      </span>
      {descriptor ? (
        <span className="mt-0.5 block text-xs font-normal leading-[18px] text-muted">
          <CollapsibleCopy text={descriptor} />
        </span>
      ) : null}
    </>
  );
}

function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm h-8 px-2 text-xs font-semibold text-muted"
      title="Copy short id"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard may be denied */
        }
      }}
    >
      {copied ? 'Copied' : 'Copy id'}
    </button>
  );
}

export function CollapsibleCopy({ text }: { text: string }) {
  const clip = clipWords(text);
  const [open, setOpen] = useState(false);
  if (!clip.collapsed) return text;
  return (
    <>
      <span className={open ? 'whitespace-pre-wrap' : undefined}>{open ? text : clip.preview}</span>{' '}
      <button
        className="relative z-10 font-semibold text-muted underline decoration-line underline-offset-2 hover:text-ink"
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}
