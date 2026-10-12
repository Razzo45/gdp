import { shortCatalogId } from './format';

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
        {descriptor ? <p className="mt-1 text-sm text-muted">{descriptor}</p> : null}
      </>
    );
  }
  return (
    <>
      <span className={size === 'compact' ? 'block font-mono text-sm font-semibold leading-[22px] text-ink' : 'block font-mono text-base font-semibold leading-6 tracking-[-0.01em] text-ink'}>
        {id}
      </span>
      {descriptor ? <span className="mt-0.5 block text-xs font-normal leading-[18px] text-muted">{descriptor}</span> : null}
    </>
  );
}
