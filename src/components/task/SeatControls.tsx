'use client';

import { useState } from 'react';
import { canAssignSeatAt, isEligibleAssignee, seatTeamLabel, type AssignmentSeat } from '@/domain/assignment';
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
  const [assigning, setAssigning] = useState<AssignmentSeat | null>(null);
  const s = view.submission;

  async function act(seat: AssignmentSeat, body: Record<string, unknown>) {
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

  const seat = (kind: AssignmentSeat, holderId: string | null, claimedAt: string | null, canClaim: boolean) => {
    const holder = holderId ? (view.people[holderId]?.name ?? 'someone') : null;
    const mine = holderId === actorId;
    const team = seatTeamLabel(kind);
    const people = assignable.filter((p) => isEligibleAssignee(p.roles, kind));
    const mayAssign = view.can.control && canAssignSeatAt(s, kind);
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
          <span className="text-muted">{team}</span>
        )}
        {!holder && canClaim && (
          <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => act(kind, { action: 'claim' })} type="button">
            Claim
          </button>
        )}
        {holder && mayAssign && (
          <button className="btn btn-sm" disabled={busy !== null} onClick={() => act(kind, { action: 'release' })} type="button">
            Release to {team}
          </button>
        )}
        {mayAssign && (
          <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setAssigning(kind)} type="button">
            {holder ? 'Reassign' : 'Assign'}
          </button>
        )}
        {assigning === kind && (
          <AssignModal
            seat={kind}
            busy={busy !== null}
            people={people}
            currentId={holderId}
            onClose={() => setAssigning(null)}
            onAssign={(userId) => act(kind, { action: 'assign', userId })}
          />
        )}
      </div>
    );
  };

  const reviewerOnly = view.can.lens === 'reviewer';

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {!reviewerOnly && seat('rubric', s.rubricAssigneeId, s.rubricClaimedAt, view.can.claimRubric)}
      {(reviewerOnly || s.stage !== 'rubric' || s.reviewerId) && seat('review', s.reviewerId, s.reviewClaimedAt, view.can.claimReview)}
    </div>
  );
}

function AssignModal({
  seat,
  people,
  currentId,
  busy,
  onClose,
  onAssign,
}: {
  seat: AssignmentSeat;
  people: Assignable[];
  currentId: string | null;
  busy: boolean;
  onClose: () => void;
  onAssign: (userId: string | null) => void;
}) {
  const team = seatTeamLabel(seat);
  const [userId, setUserId] = useState(currentId && people.some((p) => p.id === currentId) ? currentId : '');
  return (
    <Modal title={`Assign ${seat} seat`} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">
        {seat === 'rubric'
          ? 'Give this task to the Rubric Team (anyone on that team can claim it) or to one Rubric Team member.'
          : 'Give this task to the Review Team (anyone on that team can claim it) or to one reviewer.'}
      </p>
      <label className="block text-sm">
        Assignee
        <select className="input mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">{team} · all</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {people.length === 0 && <p className="mt-2 text-sm text-muted">No {team} members are active yet.</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy} type="button" onClick={() => onAssign(userId || null)}>
          Assign
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
