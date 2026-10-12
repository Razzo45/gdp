'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BankCandidate } from '@/domain/bank';
import { tokenJaccard } from '@/domain/lint';
import { FAMILY_LABELS, type Family } from '@/domain/rubric';

export type BankFocus = { rowId: string; family: Family; statement: string };

export type SeatedRow = {
  id: string;
  claimKey: string;
  statement: string;
  tag: string;
  family: Family;
  notes: string;
};

type Status = 'all' | 'in' | 'out';
type FamilyFilter = 'all' | Family;

const PAGE = 40;

type Item = {
  rowKey: string;
  key: string;
  statement: string;
  tag: string;
  family: Family;
  notes: string;
  seedId: string;
  strength?: number;
  inRubric: boolean;
  candidate: BankCandidate | null;
  similarity: number;
};

export function BankBrowser({
  bank,
  seated,
  focus,
  editable,
  busy,
  onClearFocus,
  onAdd,
  onSwap,
  canAddFamily,
}: {
  bank: BankCandidate[];
  seated: SeatedRow[];
  focus: BankFocus | null;
  editable: boolean;
  busy: boolean;
  onClearFocus: () => void;
  onAdd: (c: BankCandidate) => void;
  onSwap: (rowId: string, c: BankCandidate) => void;
  canAddFamily: (family: Family) => boolean;
}) {
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [tag, setTag] = useState('all');
  const [status, setStatus] = useState<Status>('out');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    if (focus) {
      setFamily(focus.family);
      setTag('all');
      setStatus('out');
      setQuery('');
      setLimit(PAGE);
    }
  }, [focus]);

  const seatedKeys = useMemo(() => new Set(seated.map((s) => s.claimKey).filter(Boolean)), [seated]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const c of bank) if (c.tag) set.add(c.tag);
    for (const s of seated) if (s.tag) set.add(s.tag);
    return [...set].sort();
  }, [bank, seated]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: Item[] = [];
    const unusedKeys = new Set<string>();
    for (const [index, c] of bank.entries()) {
      if (seatedKeys.has(c.claimKey) || unusedKeys.has(c.claimKey)) continue;
      unusedKeys.add(c.claimKey);
      list.push({
        rowKey: `bank:${c.claimKey}:${c.seedId}:${index}`,
        key: c.claimKey,
        statement: c.statement,
        tag: c.tag,
        family: c.family,
        notes: c.notes,
        seedId: c.seedId,
        strength: c.strength,
        inRubric: false,
        candidate: c,
        similarity: focus ? tokenJaccard(focus.statement, c.statement) : 0,
      });
    }
    for (const s of seated) {
      list.push({
        rowKey: `seated:${s.id}`,
        key: s.claimKey || s.id,
        statement: s.statement,
        tag: s.tag,
        family: s.family,
        notes: s.notes,
        seedId: '',
        inRubric: true,
        candidate: null,
        similarity: focus ? tokenJaccard(focus.statement, s.statement) : 0,
      });
    }
    const filtered = list.filter((it) => {
      if (family !== 'all' && it.family !== family) return false;
      if (tag !== 'all' && it.tag !== tag) return false;
      if (status === 'in' && !it.inRubric) return false;
      if (status === 'out' && it.inRubric) return false;
      if (q && !`${it.statement} ${it.key} ${it.tag} ${it.seedId} ${it.notes}`.toLowerCase().includes(q)) return false;
      return true;
    });
    filtered.sort((a, b) => (focus ? b.similarity - a.similarity : (b.strength ?? -1) - (a.strength ?? -1)));
    return filtered;
  }, [bank, seated, seatedKeys, focus, family, tag, status, query]);

  return (
    <div className="space-y-2">
      {focus && (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-accent bg-accent-soft p-2 text-xs">
          <div>
            <span className="font-medium">Alternatives for this seat</span>{' '}
            <span className="text-muted">({FAMILY_LABELS[focus.family]}) — closest unused claims first. Swap in replaces the seated wording.</span>
            <p className="mt-1 line-clamp-2 italic">{focus.statement}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClearFocus}>
            Clear
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select className="input" value={family} onChange={(e) => { setFamily(e.target.value as FamilyFilter); setLimit(PAGE); }}>
          <option value="all">All families</option>
          <option value="format">{FAMILY_LABELS.format}</option>
          <option value="content">{FAMILY_LABELS.content}</option>
          <option value="visual">{FAMILY_LABELS.visual}</option>
        </select>
        <select className="input" value={tag} onChange={(e) => { setTag(e.target.value); setLimit(PAGE); }}>
          <option value="all">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value as Status); setLimit(PAGE); }}>
          <option value="out">Not in rubric</option>
          <option value="in">In rubric</option>
          <option value="all">All candidates</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
          placeholder="Search statement, tag, claim, seed…"
        />
        <span className="shrink-0 text-xs text-muted">
          {items.length} of {bank.length + seated.length}
        </span>
      </div>

      <div className="max-h-[32rem] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {items.length === 0 && <p className="p-3 text-xs text-muted">No candidates match.</p>}
        {items.slice(0, limit).map((it) => {
          const canPlace = editable && !!it.candidate && !it.inRubric;
          const familyOpen = canAddFamily(it.family);
          return (
            <div key={it.rowKey} className="space-y-1 p-2 text-xs">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1">
                    <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px]">{FAMILY_LABELS[it.family]}</span>
                    {it.tag && <span className="text-muted">{it.tag}</span>}
                    {it.inRubric && <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] text-ok">in rubric</span>}
                    {it.strength !== undefined && <span className="tabular-nums text-muted">· strength {it.strength}</span>}
                    {focus && <span className="tabular-nums text-muted">· similarity {(it.similarity * 100).toFixed(0)}%</span>}
                  </div>
                  <p className="leading-snug">{it.statement}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    <span className="font-mono">{it.key}</span>
                    {it.seedId ? ` · ${it.seedId}` : ''}
                    {it.notes ? ` · ${it.notes}` : ''}
                  </p>
                </div>
                {canPlace && (
                  <div className="flex shrink-0 flex-col gap-1">
                    {focus && (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSwap(focus.rowId, it.candidate!)}>
                        Swap in
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || !familyOpen}
                      title={familyOpen ? 'Add as a new seat' : `Delete a ${FAMILY_LABELS[it.family]} seat first`}
                      onClick={() => onAdd(it.candidate!)}
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {items.length > limit && (
          <div className="p-2 text-center">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, items.length - limit)} more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
