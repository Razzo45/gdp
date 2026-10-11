import { WORK_STATE_LABEL, type WorkState } from '@/domain/workState';

export function WorkStatusPill({ state }: { state: WorkState }) {
  return <span className={`work-pill work-pill-${state}`}>{WORK_STATE_LABEL[state]}</span>;
}
