import Link from 'next/link';
import { BOARD_STATES, WORK_STATE_LABEL, type WorkState } from '@/domain/workState';

/** Same work-state chips on the dashboard pipeline and the submissions board. */
export function WorkStateChips({ counts, active }: { counts: Record<WorkState, number>; active?: WorkState }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {BOARD_STATES.map((state) => (
        <Link key={state} href={`/submissions?state=${state}`} className={`lane-chip ${active === state ? 'lane-chip-on' : ''}`}>
          {WORK_STATE_LABEL[state]}
          <span className="tabular-nums opacity-80">{counts[state] ?? 0}</span>
        </Link>
      ))}
    </div>
  );
}
