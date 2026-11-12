import { MODEL_TAG_LABEL, type ModelTag } from '@/domain/modelTag';

export function ModelTagPill({ tag, size = 'default' }: { tag: ModelTag; size?: 'default' | 'board' }) {
  return <span className={`model-pill model-pill-${tag} ${size === 'board' ? 'model-pill-board' : ''}`}>{MODEL_TAG_LABEL[tag]}</span>;
}
