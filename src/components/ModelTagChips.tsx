import Link from 'next/link';
import { MODEL_TAG_LABEL, MODEL_TAGS, type ModelTag } from '@/domain/modelTag';

function hrefFor(model: ModelTag | undefined, workState?: string, mine?: boolean) {
  const params = new URLSearchParams();
  if (workState) params.set('state', workState);
  if (mine) params.set('mine', '1');
  if (model) params.set('model', model);
  const query = params.toString();
  return query ? `/submissions?${query}` : '/submissions';
}

/** Board filter for Argon / Carbon / Gemini 3.8. */
export function ModelTagChips({
  counts,
  active,
  workState,
  mine,
}: {
  counts: Record<ModelTag, number>;
  active?: ModelTag;
  workState?: string;
  mine?: boolean;
}) {
  const all = MODEL_TAGS.reduce((sum, tag) => sum + (counts[tag] ?? 0), 0);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Link href={hrefFor(undefined, workState, mine)} className={`lane-chip ${!active ? 'lane-chip-on' : ''}`}>
        All models
        <span className="tabular-nums opacity-80">{all}</span>
      </Link>
      {MODEL_TAGS.map((tag) => (
        <Link key={tag} href={hrefFor(tag, workState, mine)} className={`lane-chip ${active === tag ? 'lane-chip-on' : ''}`}>
          {MODEL_TAG_LABEL[tag]}
          <span className="tabular-nums opacity-80">{counts[tag] ?? 0}</span>
        </Link>
      ))}
    </div>
  );
}
