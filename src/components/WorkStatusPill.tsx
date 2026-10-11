import { WORK_STATE_LABEL, type WorkState } from '@/domain/workState';

export function WorkStatusPill({ state, size = 'default' }: { state: WorkState; size?: 'default' | 'board' }) {
  return <span className={`work-pill work-pill-${state} ${size === 'board' ? 'work-pill-board' : ''}`}>{WORK_STATE_LABEL[state]}</span>;
}
