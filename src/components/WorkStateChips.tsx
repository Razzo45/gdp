import Link from 'next/link';
import { WORK_STATE_LABEL, WORK_STATES, type WorkState } from '@/domain/workState';

/** Same work-state chips on the dashboard pipeline and the submissions board. */
export function WorkStateChips({ counts, active }: { counts: Record<WorkState, number>; active?: WorkState }) {
  return (
    <div className="flex flex-wrap gap-1">
      {WORK_STATES.map((state) => (
        <Link key={state} href={`/submissions?state=${state}`} className={`chip ${active === state ? 'chip-on' : ''}`}>
          {WORK_STATE_LABEL[state]}
          <span className="tabular-nums opacity-70">{counts[state] ?? 0}</span>
        </Link>
      ))}
    </div>
  );
}
