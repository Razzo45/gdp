'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PendingCatalogReturn } from '@/domain/catalogReturn';
import { api } from './client';
import { TaskLabel } from './TaskLabel';

/** PM queue: Catalog sent a submitted task back. Accept reopens; dismiss leaves it done. */
export function CatalogReturnQueue({ items }: { items: PendingCatalogReturn[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function act(id: string, action: 'accept' | 'dismiss') {
    setBusy(`${id}:${action}`);
    setError(null);
    try {
      await api(`/api/submissions/${id}/catalog-return`, { body: { action } });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update that Catalog return.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-base font-semibold leading-6 text-ink">Catalog sent these back</h2>
        <p className="mt-1 text-sm text-muted">Accept return reopens the task on Platform returned. Keep submitted leaves it done.</p>
      </div>
      <ul className="divide-y divide-line">
        {items.map((item) => {
          const acting = busy?.startsWith(`${item.id}:`) ?? false;
          return (
            <li key={item.id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-48 flex-1">
                <Link href={`/submissions/${item.id}`} className="hover:underline">
                  <TaskLabel catalogId={item.catalogSubmissionId} title={item.title} />
                </Link>
                <p className="mt-1 text-xs leading-[18px] text-muted">
                  {item.catalogReturn.statusName ?? 'Catalog status'}
                  {item.catalogReturn.trigger ? ` · ${item.catalogReturn.trigger}` : ''}
                  {` · still ${item.stage === 'done' ? 'submitted' : item.stage} here`}
                </p>
                {item.catalogReturn.note ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                    <span className="text-muted">Why: </span>
                    {item.catalogReturn.note}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary btn-sm" disabled={acting} type="button" onClick={() => void act(item.id, 'accept')}>
                  {busy === `${item.id}:accept` ? 'Accepting…' : 'Accept return'}
                </button>
                <button className="btn btn-sm" disabled={acting} type="button" onClick={() => void act(item.id, 'dismiss')}>
                  {busy === `${item.id}:dismiss` ? 'Keeping…' : 'Keep submitted'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? <p className="text-sm text-bad">{error}</p> : null}
    </section>
  );
}
