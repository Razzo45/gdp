'use client';

import { useMemo, useState } from 'react';
import { parsePasteLines, pastedSeatDisagreements, preparePastedSeats } from '@/domain/import';
import { countFamilies, FAMILY_LABELS, quotaSpread, RUBRIC_TAGS, type RubricTag } from '@/domain/rubric';
import { Modal } from '../ui/Modal';

type DraftRow = { statement: string; tag: RubricTag | '' };

export function PasteRubricModal({
  busy,
  onClose,
  onReplace,
}: {
  busy: boolean;
  onClose: () => void;
  onReplace: (rows: { tag: RubricTag; statement: string }[]) => void;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

  function applyText(next: string) {
    setText(next);
    const parsed = parsePasteLines(next);
    setSkipped(parsed.skipped);
    setRows((current) => {
      const prev = new Map(current.map((row) => [row.statement, row.tag]));
      return parsed.rows.map((row) => ({
        statement: row.statement,
        tag: row.suggestedTag ?? prev.get(row.statement) ?? '',
      }));
    });
  }

  const tagged = rows.filter((row): row is { statement: string; tag: RubricTag } => row.tag !== '');
  const untagged = rows.length - tagged.length;
  const prepared = useMemo(() => preparePastedSeats(tagged), [tagged]);
  const seated = useMemo(() => countFamilies(prepared), [prepared]);
  const spread = useMemo(() => quotaSpread(seated), [seated]);
  const disagreements = useMemo(() => pastedSeatDisagreements(tagged), [tagged]);
  const ready = rows.length > 0 && untagged === 0 && spread.ready;

  return (
    <Modal title="Paste a rubric" onClose={onClose} wide>
      <p className="rounded-xl border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
        Saving replaces the current rubric. That rubric is gone.
      </p>
      <p className="mt-3 text-sm text-muted">One statement per line. Choose a tag for each. The save needs 5 Format, 15 Content, and 30 Visual.</p>
      <textarea
        className="input mt-3 min-h-32 font-mono text-xs"
        value={text}
        onChange={(e) => applyText(e.target.value)}
        placeholder={'The delivered presentation uses a 16:9 page size.\nFormat/File | The pack contains exactly twelve slides.'}
      />
      {skipped.length > 0 && <p className="mt-2 text-xs text-muted">Skipped {skipped.length} short or empty line{skipped.length === 1 ? '' : 's'}.</p>}

      {rows.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm">
            {FAMILY_LABELS.format} {seated.format}/5 · {FAMILY_LABELS.content} {seated.content}/15 · {FAMILY_LABELS.visual} {seated.visual}/30
          </p>
          {!ready && (
            <p className="text-sm text-warn">
              {untagged > 0 ? `${untagged} statement${untagged === 1 ? '' : 's'} still need a tag. ` : ''}
              {spread.warning}
            </p>
          )}
          {ready && disagreements > 0 && (
            <p className="text-xs text-muted">
              {disagreements} seat{disagreements === 1 ? '' : 's'} keep the tag you chose even though the wording also reads as another family.
            </p>
          )}
          {ready && disagreements === 0 && (
            <p className="text-xs text-muted">5 Format, 15 Content, 30 Visual — ready to replace.</p>
          )}
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {rows.map((row, index) => (
              <label key={`${index}:${row.statement}`} className="grid gap-2 rounded-xl border border-line p-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <select
                  className="input"
                  value={row.tag}
                  onChange={(e) => {
                    const tag = e.target.value as RubricTag | '';
                    setRows((current) => current.map((item, i) => (i === index ? { ...item, tag } : item)));
                  }}
                >
                  <option value="">Choose tag</option>
                  {RUBRIC_TAGS.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
                <p className="text-sm leading-relaxed">{row.statement}</p>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={!ready || busy} type="button" onClick={() => onReplace(tagged)}>
          {busy ? 'Replacing…' : 'Replace rubric'}
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}