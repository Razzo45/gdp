'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CALIBRATION_MAX_PERCENT, CALIBRATION_MIN_PERCENT, EVIDENCE_MIN_CHARS, calibrationInBand } from '@/domain/gates';
import { reviewApprovalScore, reviewGradesEditable } from '@/domain/review';
import { Choice } from '../Choice';
import { focusNextSeat, gradeFromKey } from '../seatKeys';
import { api } from '../client';
import { formatDate, pct } from '../format';
import { seatIndexById, seatLabel, seatsInDisplayOrder } from '@/domain/rubric';
import { formatWeight, normalisedWeights } from '@/domain/weights';
import { Pill } from '../StageBadge';
import type { PanelProps } from './TaskWorkspace';

/**
 * Human AI evaluation. Write when there is no eval yet. After a return from
 * the rubric team, rescore the existing answers, then approve or send back.
 */
export function ReviewPanel({ view, refresh, notify }: PanelProps) {
  const statements = seatsInDisplayOrder(view.rubric?.statements ?? []);
  const seats = seatIndexById(statements);
  const weights = useMemo(() => normalisedWeights(statements.length), [statements.length]);
  const latest = view.review.latest;
  const canEdit = reviewGradesEditable({ holdsReviewSeat: view.can.review, submitted: latest?.submitted });
  const [answers, setAnswers] = useState<Record<string, boolean>>(latest?.answers ?? {});
  const [evidence, setEvidence] = useState<Record<string, string>>(latest?.evidence ?? {});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dirty && latest) {
      setAnswers(latest.answers);
      setEvidence(latest.evidence);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id]);

  const score = useMemo(() => {
    const yes = statements.filter((s) => answers[s.id] === true).length;
    const no = statements.filter((s) => answers[s.id] === false).length;
    const thin = statements.filter((s) => answers[s.id] !== undefined && (evidence[s.id] ?? '').trim().length < EVIDENCE_MIN_CHARS).length;
    return { yes, no, answered: yes + no, thin, percent: yes + no === 0 ? null : (yes / (yes + no)) * 100 };
  }, [answers, evidence, statements]);

  async function persistDraft() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty) return;
    await api(`/api/submissions/${view.submission.id}/review/calibration`, { method: 'PUT', body: { answers, evidence, submit: false } });
    setDirty(false);
  }

  const schedule = () => {
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persistDraft().catch((error) => {
        notify(error instanceof Error ? error.message : 'Save failed.', 'bad');
      });
    }, 1200);
  };

  async function decide(decision: 'approved' | 'changes_requested') {
    setBusy(decision);
    try {
      await persistDraft();
      await api(`/api/submissions/${view.submission.id}/review/decision`, { body: { decision, feedback } });
      notify(decision === 'approved' ? 'Approved. The creator can now run stability.' : 'Sent back to the creator.');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Decision failed.', 'bad');
    } finally {
      setBusy(null);
    }
  }

  const submitted = view.review.submittedPercent;
  const complete = score.answered === statements.length && score.thin === 0;
  const approvalPercent = reviewApprovalScore({ latestCompletePercent: complete ? score.percent : null, submittedPercent: submitted });
  const inBand = calibrationInBand(score.percent);
  const approvalInBand = calibrationInBand(approvalPercent);

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Human Calibration</h2>
        <span className="text-xs text-muted">Grade the AI output files against the current rubric. Tab a seat, then Y or N — it moves to the next. Every answer needs an observation of at least {EVIDENCE_MIN_CHARS} characters.</span>
        <span className="ml-auto flex items-center gap-2">
          {score.percent !== null ? (
            <Pill tone={complete ? (inBand ? 'ok' : 'warn') : 'muted'}>
              {pct(score.percent)} · {score.answered}/{statements.length}
            </Pill>
          ) : null}
        </span>
      </div>

      {view.review.feedback.length > 0 && (
        <ul className="space-y-1 text-sm">
          {view.review.feedback.slice(0, 3).map((f, i) => (
            <li key={i} className="rounded-2xl border border-line bg-wash p-2">
              <strong>{f.decision === 'approved' ? 'Approved' : 'Changes requested'}</strong> by {f.reviewerId ? (view.people[f.reviewerId]?.name ?? 'reviewer') : 'reviewer'} · {formatDate(f.createdAt)}
              {f.feedback && <p className="mt-0.5 text-ink">{f.feedback}</p>}
            </li>
          ))}
        </ul>
      )}

      {view.submission.stage === 'review' && !view.can.review && view.submission.reviewerId === null && <p className="text-sm text-muted">Waiting for a reviewer to claim the review seat.</p>}

      {(view.can.review || latest) && (
        <ol className="divide-y divide-line">
          {statements.map((s) => (
            <li
              key={s.id}
              id={`rubric-statement-${s.id}`}
              data-seat-row
              tabIndex={canEdit ? 0 : -1}
              className="grid scroll-mt-24 gap-3 rounded-2xl border border-line p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent md:grid-cols-[2.25rem_minmax(0,1fr)]"
              onKeyDown={(event) => {
                if (!canEdit) return;
                const next = gradeFromKey(event);
                if (next === null) return;
                event.preventDefault();
                setAnswers((a) => ({ ...a, [s.id]: next }));
                schedule();
                focusNextSeat(event.currentTarget);
              }}
            >
              <span className="font-mono text-xs tabular-nums text-muted" title={seatLabel(seats.get(s.id))}>
                {String(seats.get(s.id) ?? '').padStart(2, '0')}
              </span>
              <div className="min-w-0 space-y-2">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                  <div className="min-w-0 space-y-2">
                    <p className="text-[15px] leading-relaxed">{s.statement}</p>
                    <span className="text-xs text-muted">{s.tag}</span>
                    {canEdit ? (
                      <label className="block">
                        <span className="text-xs font-medium text-muted">Evidence</span>
                        <textarea
                          className="input mt-1 min-h-24"
                          placeholder="Add the observation supporting this grade"
                          value={evidence[s.id] ?? ''}
                          onChange={(e) => { setEvidence((ev) => ({ ...ev, [s.id]: e.target.value })); schedule(); }}
                        />
                      </label>
                    ) : (
                      evidence[s.id] ? <p className="text-sm leading-relaxed text-muted">{evidence[s.id]}</p> : null
                    )}
                    {canEdit && answers[s.id] !== undefined && (evidence[s.id] ?? '').trim().length < EVIDENCE_MIN_CHARS ? (
                      <p className="text-[11px] text-warn">Add an observation of at least {EVIDENCE_MIN_CHARS} characters.</p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-center justify-center gap-1.5">
                    <Choice
                      value={answers[s.id] ?? null}
                      disabled={!canEdit}
                      clearable={false}
                      onChange={(value) => {
                        if (value === null) return;
                        setAnswers((a) => ({ ...a, [s.id]: value }));
                        schedule();
                      }}
                    />
                    <span className="text-xs tabular-nums text-muted" title="Percentage share of the rubric score">{formatWeight(weights[seats.get(s.id)! - 1] ?? 0)}</span>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {view.can.review && (
        <div className="space-y-3 border-t border-line pt-3">
          {score.answered !== statements.length ? (
            <p className="text-sm text-muted">{statements.length - score.answered} left to answer. Answers save as you go.</p>
          ) : score.thin > 0 ? (
            <p className="text-sm text-muted">{score.thin} need an observation of at least {EVIDENCE_MIN_CHARS} characters.</p>
          ) : !inBand ? (
            <p className="text-sm text-warn">
              Outside the {CALIBRATION_MIN_PERCENT}–{CALIBRATION_MAX_PERCENT}% band — request revisions so the creator can tighten or relax the rubric.
            </p>
          ) : null}
          <textarea className="input min-h-20" placeholder="Explain what the assignee should revise" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={busy !== null || !complete || !approvalInBand} type="button" onClick={() => void decide('approved')}>
                {busy === 'approved' ? 'Approving…' : 'Approve'}
              </button>
              <button className="btn" disabled={busy !== null || feedback.trim().length < 1} type="button" onClick={() => void decide('changes_requested')}>
                {busy === 'changes_requested' ? 'Sending…' : 'Request revisions'}
              </button>
            </div>
            {!complete ? (
              <p className="text-sm text-muted">Finish every statement before approving. You can still send this back with notes.</p>
            ) : !approvalInBand ? (
              <p className="text-sm text-muted">Approval needs an AI score between {CALIBRATION_MIN_PERCENT}% and {CALIBRATION_MAX_PERCENT}%. It is {pct(approvalPercent)} now.</p>
            ) : null}
            {feedback.trim().length < 1 ? (
              <p className="text-sm text-muted">Add a note if you are sending this back.</p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
