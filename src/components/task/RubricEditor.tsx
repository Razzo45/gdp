'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RubricStatement } from '@/db/schema';
import { parseBank, type BankCandidate } from '@/domain/bank';
import { CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, EVIDENCE_MIN_CHARS } from '@/domain/gates';
import type { LintResult } from '@/domain/lint';
import { lintStatement } from '@/domain/lint';
import { discriminationOf, isSoftSeat, seatedStrengthOf } from '@/domain/discrimination';
import { AUTO_OUTPUT, applyInferredScope, inferFileScope } from '@/domain/fileScope';
import { jobProgressView } from '@/domain/freshness';
import { FAMILY_LABELS, MAX_ROUGH_CHARS, MAX_SEED_CHARS, MAX_SEEDS, RUBRIC_TARGET, correctTag, seatedFamily, seatLabel, seatsInDisplayOrder, withSeatLabels, type Family } from '@/domain/rubric';
import { formatWeight, normalisedWeights, scoreSeats } from '@/domain/weights';
import { Choice } from '../Choice';
import { focusNextSeat, gradeFromKey } from '../seatKeys';
import { ApiError, api, uuid } from '../client';
import { BankBrowser, type BankFocus } from './BankBrowser';
import type { PanelProps } from './TaskWorkspace';

type Draft = {
  id: string;
  family: Family;
  tag: string;
  statement: string;
  notes: string;
  scope: 'output' | 'inputs';
  inputFileIds: string[];
  outputFile: string | null;
  claimKey: string | null;
  isNew?: boolean;
};

type Proposal = { statementId: string; kind: 'polish' | 'harden' | 'lint' | 'swap'; text: string; original?: string; rationale?: string; claimKey?: string };

const toDraft = (s: RubricStatement): Draft => ({
  id: s.id,
  family: seatedFamily(s),
  tag: s.tag,
  statement: s.statement,
  notes: s.notes,
  scope: s.scope,
  inputFileIds: s.inputFileIds,
  outputFile: s.outputFile,
  claimKey: s.claimKey,
});
const FAMILY_ORDER: Family[] = ['format', 'content', 'visual'];
const FAMILY_HEADING: Record<Family, string> = { format: 'Format & File', content: 'Content', visual: 'Visual' };

export function RubricEditor({ view, refresh, notify }: PanelProps) {
  const rubric = view.rubric;
  const editable = view.can.editRubric;
  const reviewer = view.can.review && view.submission.stage === 'review';
  const [drafts, setDrafts] = useState<Draft[]>(() => rubric?.statements.map(toDraft) ?? []);
  const [revision, setRevision] = useState(rubric?.revision ?? 0);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [seedMode, setSeedMode] = useState<'rough' | 'expert'>('rough');
  const [seeds, setSeeds] = useState(rubric?.seeds.join('\n') ?? '');
  const seedList = useMemo(() => seeds.split('\n').map((s) => s.trim()).filter(Boolean), [seeds]);
  const seedProblem = useMemo(() => {
    if (seedMode === 'rough') {
      if (seeds.length > MAX_ROUGH_CHARS) return `Notes are longer than ${MAX_ROUGH_CHARS} characters.`;
      return null;
    }
    if (seedList.length > MAX_SEEDS) return `${seedList.length} seeds; the maximum is ${MAX_SEEDS}.`;
    const long = seedList.findIndex((s) => s.length > MAX_SEED_CHARS);
    return long >= 0 ? `Seed ${long + 1} is longer than ${MAX_SEED_CHARS} characters. Switch to Rough notes or split the line.` : null;
  }, [seedMode, seedList, seeds.length]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [importText, setImportText] = useState('');
  const [bankFocus, setBankFocus] = useState<BankFocus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const browserRef = useRef<HTMLDivElement | null>(null);
  const bank = useMemo(() => parseBank(rubric?.generation), [rubric?.generation]);

  useEffect(() => {
    if (!rubric) return;
    if (dirty.size === 0 && deleted.size === 0 && (rubric.revision !== revision || rubric.statements.length !== drafts.length)) {
      setDrafts(rubric.statements.map(toDraft));
      setRevision(rubric.revision);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubric?.id, rubric?.revision, rubric?.statements.length]);

  const save = useCallback(async () => {
    if (!rubric || (dirty.size === 0 && deleted.size === 0)) return;
    setSaving('saving');
    const upserts = drafts.filter((d) => dirty.has(d.id)).map(({ isNew: _isNew, ...rest }) => rest);
    const deletes = [...deleted];
    try {
      const result = await api<{ revision: number; statements: RubricStatement[]; warnings: { statementId: string; reasons: string[] }[] }>(`/api/submissions/${view.submission.id}/rubric`, {
        method: 'PUT',
        body: { revision, upserts, deletes, order: drafts.map((d) => d.id) },
      });
      setRevision(result.revision);
      setDrafts((current) => {
        const byId = new Map(result.statements.map((s) => [s.id, s]));
        return current.filter((d) => byId.has(d.id)).map((d) => (dirty.has(d.id) ? toDraft(byId.get(d.id)!) : d));
      });
      setDirty(new Set());
      setDeleted(new Set());
      setSaving('saved');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && Array.isArray(error.detail['statements'])) {
        setDrafts((error.detail['statements'] as RubricStatement[]).map(toDraft));
        setRevision(Number(error.detail['revision'] ?? revision));
        setDirty(new Set());
        setDeleted(new Set());
        setSaving('conflict');
        notify(error.message, 'bad');
      } else {
        setSaving('error');
        notify(error instanceof Error ? error.message : 'Save failed.', 'bad');
      }
    }
  }, [rubric, dirty, deleted, drafts, revision, view.submission.id, notify]);
  saveRef.current = save;

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), 400);
  }, []);

  useEffect(() => {
    const flush = () => void saveRef.current();
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  const update = (id: string, patch: Partial<Draft>) => {
    setDrafts((current) => current.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setDirty((current) => new Set(current).add(id));
    schedule();
  };

  async function run(label: string, path: string, body: Record<string, unknown>, okMessage: string) {
    setBusy(label);
    try {
      await saveRef.current();
      await api(path, { body });
      notify(okMessage);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : `${label} failed.`, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function rewrite(d: Draft, mode: 'polish' | 'harden' | 'lint') {
    setBusy(`${mode}:${d.id}`);
    try {
      await saveRef.current();
      const lint = lintStatement({ statement: d.statement, tag: d.tag });
      const result = await api<{ proposal: string; rationale: string }>(`/api/submissions/${view.submission.id}/rubric/rewrite`, {
        body: { statement: d.statement, tag: d.tag, mode, lintReasons: lint.reasons },
      });
      setProposal({ statementId: d.id, kind: mode, text: result.proposal, original: d.statement, rationale: result.rationale });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Rewrite failed.', 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function proposeSwap(d: Draft) {
    setBusy(`swap:${d.id}`);
    try {
      await saveRef.current();
      const result = await api<{ candidates: BankCandidate[] }>(`/api/submissions/${view.submission.id}/rubric/replacement`, {
        body: { action: 'propose', statementId: d.id },
      });
      const top = result.candidates[0];
      if (!top) {
        notify('No unused stronger claim for this seat.', 'bad');
        return;
      }
      setProposal({
        statementId: d.id,
        kind: 'swap',
        text: top.statement,
        original: d.statement,
        claimKey: top.claimKey,
        rationale: top.strength !== undefined ? `Bank strength ${top.strength}` : undefined,
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not suggest a replacement.', 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function swapFromBank(rowId: string, candidate: BankCandidate) {
    await run('keep', `/api/submissions/${view.submission.id}/rubric/replacement`, { action: 'keep', statementId: rowId, claimKey: candidate.claimKey, revision }, 'Replacement kept. Golden autorate is stale.');
    setBankFocus(null);
  }

  async function addBankRow(candidate: BankCandidate) {
    await run('add', `/api/submissions/${view.submission.id}/rubric/replacement`, { action: 'add', claimKey: candidate.claimKey, revision }, 'Bank claim added as a new seat.');
  }

  async function keepProposal() {
    if (!proposal) return;
    if (proposal.kind === 'swap' && proposal.claimKey) {
      await run('keep', `/api/submissions/${view.submission.id}/rubric/replacement`, { action: 'keep', statementId: proposal.statementId, claimKey: proposal.claimKey, revision }, 'Replacement kept. Golden autorate is stale.');
    } else {
      update(proposal.statementId, { statement: proposal.text });
      notify('Statement saved. Review this seat\'s file scope if the claim moved.');
    }
    setProposal(null);
  }

  const counts = useMemo(() => {
    const c: Record<Family, number> = { format: 0, content: 0, visual: 0 };
    for (const d of drafts) c[seatedFamily(d)] += 1;
    return c;
  }, [drafts]);
  const quotas = rubric?.quotas ?? { format: 5, content: 15, visual: 30 };
  const target = rubric?.target ?? RUBRIC_TARGET;
  const golden = view.golden;
  const genJob = view.jobs.find((j) => j.kind === 'rubric_generate' && (j.status === 'queued' || j.status === 'running'));
  const rateJob = view.jobs.find((j) => j.kind === 'golden_autorate' && (j.status === 'queued' || j.status === 'running'));
  const autorateLocked = Boolean(rateJob);
  const groups = FAMILY_ORDER.map((family) => ({ family, rows: drafts.filter((d) => seatedFamily(d) === family) }));
  const orderedDrafts = useMemo(() => seatsInDisplayOrder(drafts.map((d) => ({ ...d, family: seatedFamily(d) }))), [drafts]);
  const weightById = useMemo(() => {
    const weights = normalisedWeights(orderedDrafts.length);
    return new Map(orderedDrafts.map((d, i) => [d.id, weights[i]!]));
  }, [orderedDrafts]);
  const liveScore = useMemo(
    () => scoreSeats(orderedDrafts.map((d) => ({ answer: golden?.verdicts[d.id] ?? null, weight: weightById.get(d.id) }))),
    [orderedDrafts, golden, weightById],
  );
  const noCount = drafts.filter((d) => golden?.verdicts[d.id] === false).length;
  const lintFails = drafts.filter((d) => lintOf(d, rubric).overall === 'fail').length;
  const strengths = seatedStrengthOf(rubric?.generation);
  const disc = discriminationOf(rubric?.generation);
  const softIds = new Set(
    drafts.filter((d) => isSoftSeat({ statement: d.statement, strength: d.claimKey ? strengths[d.claimKey] : undefined })).map((d) => d.id),
  );

  if (reviewer) {
    return (
      <section className="card space-y-3" id="rubrics-generated">
        <h2 className="font-semibold">Rubric Review</h2>
        <p className="text-sm text-muted">Read-only rubric the Reviewer Team is scoring against the AI output.</p>
        <StatementGroups groups={groups} drafts={drafts} view={view} editable={false} golden={golden} editing={null} proposal={null} busy={null} notify={notify} refresh={refresh} onEdit={() => undefined} onUpdate={() => undefined} onRewrite={() => undefined} onSwap={() => undefined} onReassess={() => undefined} onKeep={() => undefined} onDiscard={() => undefined} softIds={softIds} strengths={strengths} weightById={weightById} />
      </section>
    );
  }

  return (
    <section className="card space-y-4" id="rubrics-generated">
      <div>
        <h2 className="font-semibold">Golden Evaluation</h2>
        <p className="text-sm text-muted">Build the grading rubric, review the Golden files, and autorate the expected result.</p>
      </div>

      {editable && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" checked={seedMode === 'rough'} onChange={() => setSeedMode('rough')} />
              <span>
                <strong>Rough notes</strong>
                <span className="block text-xs text-muted">Every distinct check becomes a seed. Those expand into a bank; the best rows are seated.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" checked={seedMode === 'expert'} onChange={() => setSeedMode('expert')} />
              <span>
                <strong>Expert statements</strong>
                <span className="block text-xs text-muted">One statement per non-empty line; no Gemini seed transform.</span>
              </span>
            </label>
          </div>
          <textarea
            className="input min-h-28 font-mono text-xs"
            value={seeds}
            onChange={(e) => setSeeds(e.target.value)}
            maxLength={50_000}
            placeholder={seedMode === 'rough' ? 'Paste the criteria…' : 'One grading statement per line…'}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{seeds.length} / {MAX_ROUGH_CHARS} characters</span>
            <span className={seedProblem ? 'text-bad' : ''}>
              {seedProblem ??
                (seedMode === 'rough'
                  ? seeds.trim()
                    ? 'Each check becomes a seed, the bank is ranked, then the strongest rows are seated.'
                    : 'Empty notes: the model proposes every distinct check from the brief.'
                  : seedList.length === 0
                    ? 'No seeds: the model will propose them.'
                    : `${seedList.length} / ${MAX_SEEDS} seeds`)}
            </span>
            <span className="ml-auto">{Number(quotas.format) + Number(quotas.content) + Number(quotas.visual)} statements · {quotas.format} Format · {quotas.content} Content · {quotas.visual} Visual</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : saving === 'conflict' ? 'A newer rubric exists — copy your changes, then reload.' : editable ? 'Edits save automatically.' : 'Read-only'}</span>
        {saving === 'error' && (
          <button className="btn btn-sm" type="button" onClick={() => void saveRef.current()}>
            Retry save
          </button>
        )}
        {editable && (
          <button
            className={`btn ml-auto ${drafts.length === 0 ? 'btn-primary' : ''}`}
            disabled={busy !== null || Boolean(genJob) || Boolean(rateJob)}
            title={rateJob ? 'Wait for autorating to finish' : genJob ? 'Generation already running' : 'Generate the rubric from the notes above'}
            type="button"
            onClick={() => {
              if (seedProblem) {
                notify(seedProblem, 'bad');
                return;
              }
              const body =
                seedMode === 'rough'
                  ? { requestId: uuid(), seedMode: 'rough', source: seeds, target: rubric?.target ?? 50 }
                  : { requestId: uuid(), seedMode: 'expert', seeds: seedList, target: rubric?.target ?? 50 };
              void run('generate', `/api/submissions/${view.submission.id}/rubric/generate`, body, 'Generation queued. Watch the progress card.');
            }}
          >
            {genJob ? 'Generating…' : busy === 'generate' ? 'Starting…' : drafts.length === 0 ? 'Generate rubric' : 'Regenerate rubric'}
          </button>
        )}
      </div>

      {(genJob || rateJob || busy === 'golden' || busy === 'generate') && (
        <JobProgressCard
          job={
            genJob ??
            rateJob ??
            (busy === 'generate'
              ? { kind: 'rubric_generate', status: 'queued', progress: { note: 'Starting rubric generation…' } }
              : { kind: 'golden_autorate', status: 'queued', progress: { note: 'Starting Golden…', done: 0, total: drafts.length } })
          }
        />
      )}

      {editable && drafts.length > 0 && drafts.length < target && FAMILY_ORDER.some((f) => counts[f] < (quotas[f] ?? 0)) && (
        <div className="rounded-2xl border border-warn bg-warn-soft p-3 text-sm">
          <strong>Some rubric sections need more checks</strong>
          <ul className="mt-1 text-xs">
            {FAMILY_ORDER.filter((f) => counts[f] < (quotas[f] ?? 0)).map((f) => (
              <li key={f}>
                {FAMILY_HEADING[f]} short by {(quotas[f] ?? 0) - counts[f]} ({counts[f]} of {quotas[f]} seated)
              </li>
            ))}
          </ul>
        </div>
      )}

      {softIds.size > 0 && editable && (
        <div className="rounded-2xl border border-warn bg-warn-soft p-3 text-sm">
          <strong>Soft seats ({softIds.size})</strong>
          <span className="text-muted"> — mediocre work would pass these. Harden them or swap a stronger claim.</span>
          <ul className="mt-2 space-y-1 text-xs">
            {(() => {
              let n = 0;
              return groups.flatMap(({ rows }) =>
                rows.map((d) => {
                  n += 1;
                  if (!softIds.has(d.id)) return null;
                  const hint = disc?.hints.find((h) => h.claimKey && h.claimKey === d.claimKey);
                  return (
                    <li key={d.id} className="flex flex-wrap items-center gap-2">
                      <a className="font-medium underline" href={`#rubric-statement-${d.id}`}>
                        Seat {n}
                      </a>
                      <span className="min-w-0 truncate text-muted">{d.statement}</span>
                      <button className="btn btn-sm" disabled={busy !== null} type="button" onClick={() => void rewrite(d, 'harden')}>
                        Harden
                      </button>
                      {hint?.replacement && <span className="text-muted">Bank has a tighter claim ready in Alternatives.</span>}
                    </li>
                  );
                }),
              );
            })()}
          </ul>
        </div>
      )}

      {view.review.feedback[0]?.decision === 'changes_requested' && view.submission.stage === 'rubric' && (
        <div className="rounded-2xl border border-warn bg-warn-soft p-3 text-sm">
          <strong>Reviewer requested changes</strong>
          {view.review.submittedPercent !== null && <> (AI scored {view.review.submittedPercent.toFixed(1)}%; band is {CALIBRATION_MIN_PERCENT}–{CALIBRATION_MAX_PERCENT}%)</>}: {view.review.feedback[0].feedback}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="space-y-2">
        <p className="text-xs text-muted">
          A Yes earns the statement&apos;s percentage; a No earns none. Unanswered statements stay outside the current score.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {drafts.length} statements · {formatWeight(liveScore.totalWeight)} total · {FAMILY_ORDER.map((f) => `${FAMILY_LABELS[f]} ${counts[f]}/${quotas[f]}`).join(' · ')}
          </span>
          {liveScore.graded > 0 && (
            <>
              <span className="text-xs text-muted">
                {liveScore.passed} of {liveScore.graded} passed · {formatWeight(liveScore.passedWeight)} weight
              </span>
              <span className="text-xs text-muted">
                {liveScore.outstanding === 0
                  ? `weighted score ${(liveScore.fraction * 100).toFixed(1)}%`
                  : `weighted score ${(liveScore.floor * 100).toFixed(1)}–${(liveScore.ceiling * 100).toFixed(1)}%`}
              </span>
            </>
          )}
          {golden && (
            <span className="text-xs text-muted">
              Golden 100: {golden.gate.ok ? 'yes' : 'no'} · {noCount} No · {golden.gate.unanswered} unanswered
              {lintFails > 0 && ` · ${lintFails} lint`}
              {Object.values(golden.sources).includes('human') && ' · human override'}
            </span>
          )}
          {(editable || view.can.runGolden) && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {editable ? (
                <>
                  <a className="btn btn-ghost btn-sm" href={`/api/submissions/${view.submission.id}/rubric/evidence`}>
                    Evidence JSON
                  </a>
                  <button className="btn btn-ghost btn-sm" disabled={busy !== null} type="button" onClick={() => run('lint', `/api/submissions/${view.submission.id}/rubric/lint`, { scope: 'unchecked' }, 'Wording checked.')}>
                    Check wording
                  </button>
                </>
              ) : null}
              {view.can.runGolden ? (
                <button
                  className="btn btn-primary"
                  disabled={busy !== null || autorateLocked || drafts.length === 0}
                  type="button"
                  onClick={() => run('golden', `/api/submissions/${view.submission.id}/golden`, { requestId: uuid() }, 'Autorating golden files')}
                >
                  {rateJob ? progressLabel(rateJob) : 'Autorate Golden'}
                </button>
              ) : null}
            </div>
          )}
        </div>
        </div>
      )}

      <StatementGroups
        groups={groups}
        drafts={drafts}
        view={view}
        editable={editable && !autorateLocked}
        golden={golden}
        editing={editing}
        proposal={proposal}
        busy={busy}
        notify={notify}
        refresh={refresh}
        onEdit={setEditing}
        onUpdate={update}
        onRewrite={rewrite}
        onSwap={(d) => void proposeSwap(d)}
        onReassess={(d) => run('reassess', `/api/submissions/${view.submission.id}/golden`, { requestId: uuid(), statementIds: [d.id] }, 'Reassessing Golden statement')}
        onKeep={keepProposal}
        onDiscard={() => setProposal(null)}
        softIds={softIds}
        strengths={strengths}
        weightById={weightById}
      />

      {(bank.length > 0 || drafts.length > 0) && (
        <div ref={browserRef}>
        <details className="rounded-xl border border-line">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
            Bank browser — {bank.length} unused candidate{bank.length === 1 ? '' : 's'}
          </summary>
          <div className="border-t border-line p-3">
            {bank.length === 0 ? (
              <p className="text-xs text-muted">No unused bank. Generate a rubric to browse alternatives by tag, name, or seed.</p>
            ) : (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  Search unused factory-bank claims by statement, tag, claim key, or seed. Find alternatives on a seat to rank closest wording first, then swap in or add as a new row.
                </p>
                <BankBrowser
                  bank={bank}
                  seated={drafts.map((d) => {
                    const live = rubric?.statements.find((s) => s.id === d.id);
                    return { id: d.id, claimKey: live?.claimKey || d.id, statement: d.statement, tag: d.tag, family: seatedFamily(d), notes: d.notes };
                  })}
                  focus={bankFocus}
                  editable={editable && !autorateLocked}
                  busy={busy !== null}
                  onClearFocus={() => setBankFocus(null)}
                  onAdd={addBankRow}
                  onSwap={swapFromBank}
                />
              </>
            )}
          </div>
        </details>
        </div>
      )}

      {editable && (
        <details className="rounded-xl border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">Paste statements</summary>
          <textarea className="input mt-2 min-h-24 font-mono text-xs" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="One statement per line. Optional Tag | statement" />
          <button
            className="btn mt-2"
            disabled={!importText.trim() || busy !== null}
            onClick={() => run('import', `/api/submissions/${view.submission.id}/rubric/import`, { text: importText, revision }, 'Statements imported.').then(() => setImportText(''))}
          >
            Import
          </button>
        </details>
      )}
    </section>
  );
}

function lintOf(d: Draft, rubric: PanelProps['view']['rubric']): LintResult {
  const stored = rubric?.statements.find((s) => s.id === d.id)?.lint as LintResult | undefined;
  if (stored && stored.source === 'ai') return stored;
  return lintStatement({ statement: d.statement, tag: d.tag });
}

function progressLabel(job: { progress?: { done?: number; total?: number; note?: string }; status: string }) {
  const p = job.progress ?? {};
  if (p.note) return p.note;
  if (p.total) return `${p.done ?? 0}/${p.total}`;
  return job.status === 'queued' ? 'Queued' : 'Working';
}

function JobProgressCard({ job }: { job: { kind: string; status: string; progress?: { done?: number; total?: number; note?: string; stages?: { name: string; detail: string; state: string }[]; seeds?: { total: number; ok: number; thin: number; failed: number } } } }) {
  const p = job.progress ?? {};
  const live = job.kind === 'rubric_generate'
    ? {
        title: job.status === 'queued' ? 'Queued — next to generate' : p.note || 'Rubric regeneration in progress',
        ratio: p.total ? Math.min(1, (p.done ?? 0) / p.total) : job.status === 'running' ? 0.15 : 0,
        detail: p.note && p.seeds ? `${p.seeds.ok} ok · ${p.seeds.thin} thin · ${p.seeds.failed} failed` : p.note ?? null,
      }
    : jobProgressView(job);
  return (
    <div className="rounded-xl border border-line bg-accent-soft/40 p-3 text-sm">
      <div className="font-medium">{live.title}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
        <div className="h-full bg-accent" style={{ width: `${Math.round(live.ratio * 100)}%` }} />
      </div>
      {live.detail ? <p className="mt-1 text-xs text-muted">{live.detail}</p> : null}
      {p.stages && p.stages.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <tbody>
            {p.stages.map((s, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-2 font-medium">{s.name}</td>
                <td className="py-0.5 text-muted">{s.detail || (s.state === 'active' ? 'In progress' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function catalogFiles(view: PanelProps['view']) {
  return {
    goldens: view.brief.goldenFiles.map((file) => ({ id: file.id, name: file.name })),
    inputs: view.brief.inputFiles.map((file) => ({ id: file.id, name: file.name })),
    aiOutputs: view.aiOutputs.map((file) => ({ id: file.id, name: file.name })),
  };
}

function StatementGroups(props: {
  groups: { family: Family; rows: Draft[] }[];
  drafts: Draft[];
  view: PanelProps['view'];
  editable: boolean;
  golden: PanelProps['view']['golden'];
  editing: string | null;
  proposal: Proposal | null;
  busy: string | null;
  notify: PanelProps['notify'];
  refresh: PanelProps['refresh'];
  onEdit: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<Draft>) => void;
  onRewrite: (d: Draft, mode: 'polish' | 'harden' | 'lint') => void;
  onSwap: (d: Draft) => void;
  onReassess: (d: Draft) => void;
  onKeep: () => void;
  onDiscard: () => void;
  softIds: Set<string>;
  strengths: Record<string, number>;
  weightById: Map<string, number>;
}) {
  let next = 0;
  const pad = String(props.drafts.length).length;
  return (
    <div className="space-y-5">
      {props.groups.map(({ family, rows }) => {
        if (rows.length === 0) return null;
        const start = next + 1;
        const end = next + rows.length;
        return (
          <div key={family}>
            <h3 className="mb-1 text-sm font-semibold">
              {FAMILY_HEADING[family]}{' '}
              <span className="font-normal text-muted">
                {seatLabel(start)}
                {end !== start ? `–${end}` : ''}
              </span>
            </h3>
            <ol className="flex flex-col gap-3">
              {rows.map((d) => {
                next += 1;
                return <SeatRow key={d.id} n={next} pad={pad} d={d} {...props} />;
              })}
            </ol>
          </div>
        );
      })}
      {props.drafts.length === 0 && <p className="py-6 text-center text-sm text-muted">The run produced no statements.</p>}
    </div>
  );
}

function SeatRow({ n, pad, d, view, editable, golden, editing, proposal, busy, notify, refresh, softIds, weightById, onEdit, onUpdate, onRewrite, onSwap, onReassess, onKeep, onDiscard }: { n: number; pad: number; d: Draft } & Omit<Parameters<typeof StatementGroups>[0], 'groups' | 'drafts'>) {
  const lint = lintOf(d, view.rubric);
  const verdict = golden?.verdicts[d.id];
  const source = golden?.sources[d.id];
  const audit = golden?.audit[d.id];
  const error = golden?.errors[d.id] ? withSeatLabels(golden.errors[d.id]!, new Map([[d.id, n]])) : undefined;
  const open = editing === d.id;
  const mine = proposal?.statementId === d.id;
  const weight = weightById.get(d.id);
  const [note, setNote] = useState(golden?.evidence[d.id] ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setNote(golden?.evidence[d.id] ?? '');
  }, [d.id, golden?.evidence[d.id], golden?.sources[d.id]]);

  async function persist(next: boolean, evidence: string) {
    const text = evidence.trim();
    if (text.length < EVIDENCE_MIN_CHARS) {
      notify(`Add the observation supporting this grade (at least ${EVIDENCE_MIN_CHARS} characters).`, 'bad');
      return;
    }
    try {
      await api(`/api/submissions/${view.submission.id}/golden/override`, { body: { statementId: d.id, verdict: next, evidence: text } });
      notify(`${seatLabel(n)} marked ${next ? 'Yes' : 'No'} · Source: human.`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not save the override.', 'bad');
    }
  }

  return (
    <li
      id={`rubric-statement-${d.id}`}
      data-seat-row
      tabIndex={0}
      className="grid scroll-mt-24 gap-3 rounded-2xl border border-line p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent target:border-accent md:grid-cols-[2.25rem_minmax(0,1fr)]"
      onKeyDown={(event) => {
        if (!editable) return;
        const next = gradeFromKey(event);
        if (next === null) return;
        event.preventDefault();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('.choice-opt')[next ? 0 : 1]?.click();
        focusNextSeat(event.currentTarget);
      }}
    >
      <div className="font-mono text-xs tabular-nums text-muted" title={seatLabel(n)}>
        {String(n).padStart(pad, '0')}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="min-w-0 space-y-2">
            {open && editable ? (
              <textarea
                className="input min-h-[3rem]"
                rows={3}
                value={d.statement}
                onChange={(e) => {
                  const statement = e.target.value;
                  const files = catalogFiles(view);
                  const patch: Partial<Draft> = { statement, tag: correctTag(statement, d.tag) };
                  if (!d.outputFile) Object.assign(patch, inferFileScope(statement, files.inputs, files.goldens));
                  onUpdate(d.id, patch);
                }}
              />
            ) : (
              <p className="text-[15px] leading-relaxed">
                {d.statement}
                {softIds.has(d.id) && <span className="badge badge-warn ml-2 align-middle">Soft</span>}
              </p>
            )}
            {open && editable && <SeatScopeLine d={d} view={view} onUpdate={onUpdate} />}
            {d.notes && <p className="text-xs text-muted">Only if {d.notes}</p>}
            {editable ? (
              <label className="block">
                <span className="text-xs font-medium text-muted">Evidence</span>
                <textarea
                  className="input mt-1 min-h-24"
                  placeholder="Add the observation supporting this grade"
                  value={note}
                  onChange={(e) => {
                    const text = e.target.value;
                    setNote(text);
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = setTimeout(() => {
                      if (verdict === null || verdict === undefined) return;
                      if (text.trim().length < EVIDENCE_MIN_CHARS) return;
                      if (text.trim() === (golden?.evidence[d.id] ?? '').trim()) return;
                      void persist(verdict, text);
                    }, 600);
                  }}
                />
              </label>
            ) : (
              (golden?.evidence[d.id] || audit?.human?.evidence) && (
                <p className="text-sm leading-relaxed text-muted">{golden?.evidence[d.id] || audit?.human?.evidence}</p>
              )
            )}
            {source === 'human' && audit?.ai && (
              <p className="text-xs text-quiet">
                AI{audit.ai.model ? ` · ${audit.ai.model}` : ''}: {audit.ai.verdict === true ? 'Yes' : audit.ai.verdict === false ? 'No' : '—'}
                {audit.ai.evidence ? ` — ${audit.ai.evidence}` : ''}
              </p>
            )}
          </div>
          <div className="flex flex-col items-center justify-center gap-1.5 self-center">
            <Choice
              value={verdict ?? null}
              disabled={!editable}
              clearable={false}
              onChange={(v) => {
                if (v === null || v === verdict) return;
                void persist(v, note);
              }}
            />
            {weight !== undefined && (
              <span className="tabular-nums text-xs text-muted" title="Percentage share of the rubric score">
                {formatWeight(weight)}
              </span>
            )}
            {source === 'ai' && (
              <p className="text-[11px] text-quiet">
                Source: AI{audit?.ai?.model ? ` · ${audit.ai.model}` : ''}
              </p>
            )}
            {source === 'human' && <p className="text-[11px] text-quiet">Source: Human</p>}
            {source === 'stale' && <p className="text-[11px] text-quiet">Source: Stale — statement edited</p>}
          </div>
        </div>
        {lint.overall === 'fail' && (
          <div className="rounded-2xl border border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
            <p className="font-semibold">Things to check ({lint.reasons.length})</p>
            <p className="mt-1 text-muted">Wording check — keep the sentence if it is the requirement you mean.</p>
            <ul className="mt-1 list-disc pl-4">
              {lint.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {lint.rewriteSuggestion && <p className="mt-1 text-ink">{lint.rewriteSuggestion}</p>}
            {editable && (
              <button className="btn btn-sm mt-2" disabled={busy !== null} type="button" onClick={() => onRewrite(d, 'lint')}>
                Fix wording
              </button>
            )}
          </div>
        )}
        {mine && (
          <div className={`rounded-lg p-2 text-sm ${proposal.kind === 'swap' ? 'border border-warn bg-warn-soft' : 'border border-accent bg-accent-soft'}`}>
            <p className="text-[11px] font-medium text-muted">{proposal.kind === 'swap' ? 'Suggested replacement' : proposal.kind === 'harden' ? 'Harden proposal' : proposal.kind === 'polish' ? 'Polish proposal' : 'Wording proposal'}</p>
            {proposal.original && <p className="mt-1 text-xs text-muted line-through">{proposal.original}</p>}
            <p className="mt-1">{proposal.text}</p>
            {proposal.rationale && <p className="mt-1 text-xs text-muted">{proposal.rationale}</p>}
            <div className="mt-2 flex gap-2">
              <button className="btn btn-primary btn-sm" type="button" onClick={onKeep}>{proposal.kind === 'swap' ? 'Use this claim' : 'Keep'}</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={onDiscard}>{proposal.kind === 'swap' ? 'Discard replacement' : 'Discard'}</button>
            </div>
          </div>
        )}
        {editable && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button className="seat-pill seat-pill-edit" type="button" onClick={() => onEdit(open ? null : d.id)}>{open ? 'Done' : 'Edit'}</button>
            <button className="seat-pill" disabled={busy !== null} type="button" onClick={() => onRewrite(d, 'polish')}>Polish</button>
            <button className="seat-pill" disabled={busy !== null} type="button" onClick={() => onRewrite(d, 'harden')}>Harden</button>
            <button className="seat-pill" disabled={busy !== null} type="button" onClick={() => onSwap(d)}>Suggest replacement</button>
            <button className="seat-act ml-auto" disabled={busy !== null} type="button" onClick={() => onReassess(d)} title="Reassess only this statement against the Golden">
              Reassess
            </button>
          </div>
        )}
        {error && (
          <p className="text-xs text-bad">
            {seatLabel(n)} could not be graded: {error}
            {editable && (
              <>
                {' '}
                <button className="underline" type="button" onClick={() => onReassess(d)}>
                  Reassess
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

function SeatScopeLine({ d, view, onUpdate }: { d: Draft; view: PanelProps['view']; onUpdate: (id: string, patch: Partial<Draft>) => void }) {
  const files = catalogFiles(view);
  if (files.inputs.length === 0) return null;
  const live = applyLiveScope(d, files);
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {files.inputs.map((file) => (
        <label key={file.id} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={live.scope === 'inputs' && live.inputFileIds.includes(file.id)}
            onChange={(e) => {
              const inputFileIds = e.target.checked ? [...live.inputFileIds.filter((id) => id !== file.id), file.id] : live.inputFileIds.filter((id) => id !== file.id);
              onUpdate(d.id, {
                scope: inputFileIds.length ? 'inputs' : 'output',
                inputFileIds,
                outputFile: inputFileIds.length ? (d.outputFile === AUTO_OUTPUT ? null : d.outputFile) : AUTO_OUTPUT,
              });
            }}
          />
          {file.name}
        </label>
      ))}
    </div>
  );
}

function applyLiveScope(d: Draft, files: ReturnType<typeof catalogFiles>) {
  return applyInferredScope({ statement: d.statement, scope: d.scope, inputFileIds: d.inputFileIds, outputFile: d.outputFile }, files.inputs, files.goldens);
}

