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
        <h1 className="mt-1 font-mono text-2xl font-semibold tracking-[-0.025em] text-ink">{id}</h1>
        {descriptor ? <p className="mt-1 text-sm text-muted"><HeroCopy text={descriptor} /></p> : null}
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
          <HeroCopy text={descriptor} />
        </span>
      ) : null}
    </>
  );
}

function HeroCopy({ text }: { text: string }) {
  const clip = clipWords(text);
  const [open, setOpen] = useState(false);
  if (!clip.collapsed) return text;
  return (
    <>
      {open ? text : clip.preview}{' '}
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
