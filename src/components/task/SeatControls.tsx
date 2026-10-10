'use client';

import { useState } from 'react';
import type { SubmissionView } from '@/lib/services/view';
import { api } from '../client';
import { TimeAgo } from '../TimeAgo';
import { Modal } from '../ui/Modal';

export interface Assignable {
  id: string;
  name: string;
  roles: string[];
}

export function SeatControls({ view, actorId, assignable, refresh, notify }: { view: SubmissionView; actorId: string; assignable: Assignable[]; refresh: () => Promise<void>; notify: (m: string, t?: 'ok' | 'bad') => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<'rubric' | 'review' | null>(null);
  const s = view.submission;

  async function act(seat: 'rubric' | 'review', body: Record<string, unknown>) {
    setBusy(seat);
    try {
      await api(`/api/submissions/${s.id}/seat`, { body: { seat, ...body } });
      setAssigning(null);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Seat change failed.', 'bad');
    } finally {
      setBusy(null);
    }
  }

  const seat = (kind: 'rubric' | 'review', holderId: string | null, claimedAt: string | null, canClaim: boolean, roleFilter: string) => {
    const holder = holderId ? (view.people[holderId]?.name ?? 'someone') : null;
    const mine = holderId === actorId;
    const people = assignable.filter((p) => p.roles.includes(roleFilter) || p.roles.includes('admin') || p.roles.includes('pm'));
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{kind}</span>
        {holder ? (
          <span>
            <strong>{mine ? 'You' : holder}</strong>{' '}
            <span className="text-xs text-muted">
              since <TimeAgo iso={claimedAt} />
            </span>
          </span>
        ) : (
          <span className="text-muted">Unassigned</span>
        )}
        {!holder && canClaim && (
          <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => act(kind, { action: 'claim' })} type="button">
            Claim
          </button>
        )}
        {holder && view.can.control && (
          <button className="btn btn-sm" disabled={busy !== null} onClick={() => act(kind, { action: 'release' })} type="button">
            Release
          </button>
        )}
        {view.can.control && (
          <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setAssigning(kind)} type="button">
            {holder ? 'Reassign' : 'Assign'}
          </button>
        )}
        {assigning === kind && (
          <AssignModal
            seat={kind}
            busy={busy !== null}
            people={people}
            hasHolder={Boolean(holder)}
            onClose={() => setAssigning(null)}
            onAssign={(userId) => act(kind, { action: 'assign', userId })}
            onClear={() => act(kind, { action: 'assign', userId: null })}
          />
        )}
      </div>
    );
  };

  const reviewerOnly = view.can.lens === 'reviewer';

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {!reviewerOnly && seat('rubric', s.rubricAssigneeId, s.rubricClaimedAt, view.can.claimRubric, 'rubric_creator')}
      {(reviewerOnly || s.stage !== 'rubric' || s.reviewerId) && seat('review', s.reviewerId, s.reviewClaimedAt, view.can.claimReview, 'reviewer')}
    </div>
  );
}

function AssignModal({
  seat,
  people,
  hasHolder,
  busy,
  onClose,
  onAssign,
  onClear,
}: {
  seat: 'rubric' | 'review';
  people: Assignable[];
  hasHolder: boolean;
  busy: boolean;
  onClose: () => void;
  onAssign: (userId: string) => void;
  onClear: () => void;
}) {
  const [userId, setUserId] = useState(people[0]?.id ?? '');
  return (
    <Modal title={hasHolder ? 'Reassign submission' : 'Assign submission'} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">Choose a person who can hold the {seat} seat.</p>
      <label className="block text-sm">
        Person
        <select className="input mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {people.length === 0 && <option value="">No eligible people</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.roles.join(', ')}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy || !userId} type="button" onClick={() => onAssign(userId)}>
          Assign person
        </button>
        {hasHolder && (
          <button className="btn" disabled={busy} type="button" onClick={onClear}>
            Clear assignment
          </button>
        )}
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
