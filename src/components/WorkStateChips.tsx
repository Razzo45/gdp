import Link from 'next/link';
import type { ModelTag } from '@/domain/modelTag';
import { BOARD_STATES, WORK_STATE_LABEL, type WorkState } from '@/domain/workState';

function hrefFor(state: WorkState, modelTag?: ModelTag, mine?: boolean) {
  const params = new URLSearchParams({ state });
  if (modelTag) params.set('model', modelTag);
  if (mine) params.set('mine', '1');
  return `/submissions?${params.toString()}`;
}

/** Same work-state chips on the dashboard pipeline and the submissions board. */
export function WorkStateChips({
  counts,
  active,
  modelTag,
  mine,
}: {
  counts: Record<WorkState, number>;
  active?: WorkState;
  modelTag?: ModelTag;
  mine?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {BOARD_STATES.map((state) => (
        <Link key={state} href={hrefFor(state, modelTag, mine)} className={`lane-chip ${active === state ? 'lane-chip-on' : ''}`}>
          {WORK_STATE_LABEL[state]}
          <span className="tabular-nums opacity-80">{counts[state] ?? 0}</span>
        </Link>
      ))}
    </div>
  );
}
