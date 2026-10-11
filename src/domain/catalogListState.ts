/**
 * Live GDP board classifier, ported from legacy `classifyCatalogListState`.
 * Work status is the configured work stage, or a status reachable forward
 * from handoff. Names are never used to decide a lane.
 */
export const CATALOG_LIST_STATES = [
  'unassigned',
  'preparing',
  'review',
  'review_return',
  'approved',
  'platform_return',
  'submitted',
  'unknown',
] as const;
export type CatalogListState = (typeof CATALOG_LIST_STATES)[number];

export interface CatalogStateInput {
  statusId: string | null;
  workStatusId?: string;
  handoffStatusId?: string;
  statuses: unknown;
  transitions: unknown;
  reviewStatus?: string | null;
  assigned?: boolean;
  localWork?: {
    savedStatusId: string | null;
    rubricOwned: boolean;
    runCreatedAt: string | null;
    answersUpdatedAt: string | null;
    reviewCurrent: boolean;
  } | null;
  sourceUnavailable?: boolean;
  projectWorkflowVerified?: boolean;
  currentStatusVerified?: boolean;
  currentStatusAt?: string | null;
  transitionLog?: unknown;
  revision?: { beforeStatusId: string | null; afterStatusId: string | null; substantive: boolean; createdAt?: string } | null;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const normalized = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const forward = (trigger: unknown) => ['next', 'approve', 'submit', 'resubmit', 'assign'].includes(normalized(trigger));
const returned = (trigger: unknown) =>
  ['revise', 'reject', 'revise-to-expert', 'revise-to-creator', 'send-to-rubric', 'send-to-rubrics'].includes(normalized(trigger));

/** Statuses reachable forward from handoff — live Submitted, including later client-visible steps. */
export function submittedCatalogStatusIds(input: Pick<CatalogStateInput, 'workStatusId' | 'handoffStatusId' | 'statuses' | 'transitions'>): Set<string> {
  const work = normalized(input.workStatusId);
  const handoff = normalized(input.handoffStatusId);
  const known = new Set(
    (Array.isArray(input.statuses) ? input.statuses : []).map((entry) => normalized(object(entry)['statusId'])).filter(Boolean),
  );
  const edges = (Array.isArray(input.transitions) ? input.transitions : []).map(object);
  const returnDestinations = new Set(edges.filter((edge) => returned(edge['trigger'])).map((edge) => normalized(edge['to'])));
  const submitted = new Set(handoff && handoff !== work && known.has(handoff) ? [handoff] : []);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      const to = normalized(edge['to']);
      if (submitted.has(normalized(edge['from'])) && known.has(to) && to !== work && !returnDestinations.has(to) && forward(edge['trigger']) && !submitted.has(to)) {
        submitted.add(to);
        changed = true;
      }
    }
  }
  return submitted;
}

export function validStateTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export function compareCatalogTimes(left: string, right: string): number {
  const fraction = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(3, 9));
  return Date.parse(left) - Date.parse(right) || fraction(left) - fraction(right);
}

export function classifyCatalogListState(input: CatalogStateInput): CatalogListState {
  const status = normalized(input.statusId);
  const work = normalized(input.workStatusId);
  const handoff = normalized(input.handoffStatusId);
  const known = new Set(
    (Array.isArray(input.statuses) ? input.statuses : []).map((entry) => normalized(object(entry)['statusId'])).filter(Boolean),
  );
  const edges = (Array.isArray(input.transitions) ? input.transitions : []).map(object);
  const returnDestinations = new Set(edges.filter((edge) => returned(edge['trigger'])).map((edge) => normalized(edge['to'])));
  const submitted = submittedCatalogStatusIds(input);
  const revisionStatus = normalized(input.revision?.afterStatusId);
  const revisionBefore = normalized(input.revision?.beforeStatusId);
  const currentIsNewer =
    input.currentStatusVerified === true ||
    (validStateTime(input.currentStatusAt) !== null &&
      validStateTime(input.revision?.createdAt) !== null &&
      compareCatalogTimes(input.currentStatusAt!, input.revision!.createdAt!) > 0);
  const revisionIsCurrent = input.revision?.substantive === true && !currentIsNewer;
  const effectiveStatus = revisionIsCurrent ? revisionStatus : status;
  if (input.sourceUnavailable) return 'unknown';
  if (!work || !handoff || work === handoff || !known.has(work) || !known.has(handoff)) return 'unknown';
  const activeReturn =
    revisionIsCurrent &&
    known.has(revisionStatus) &&
    submitted.has(revisionBefore) &&
    edges.some((edge) => submitted.has(normalized(edge['from'])) && normalized(edge['to']) === revisionStatus && returned(edge['trigger']));
  if (activeReturn) return 'platform_return';
  const latest = (Array.isArray(input.transitionLog) ? input.transitionLog : [])
    .map(object)
    .filter((entry) => validStateTime(entry['timestamp']) !== null)
    .sort((a, b) => compareCatalogTimes(String(b['timestamp']), String(a['timestamp'])))[0];
  if (
    !revisionIsCurrent &&
    latest &&
    normalized(latest['toStatus']) === effectiveStatus &&
    submitted.has(normalized(latest['fromStatus'])) &&
    edges.some(
      (edge) =>
        normalized(edge['from']) === normalized(latest['fromStatus']) &&
        normalized(edge['to']) === effectiveStatus &&
        returned(edge['trigger']),
    )
  ) {
    return 'platform_return';
  }
  if (effectiveStatus && submitted.has(effectiveStatus)) return 'submitted';
  const clash = input.revision?.substantive && (!currentIsNewer || revisionStatus === status);
  const evidence = input.localWork;
  const continuedWork = Boolean(
    evidence?.rubricOwned &&
      input.assigned &&
      normalized(evidence.savedStatusId) === work &&
      validStateTime(evidence.runCreatedAt) &&
      validStateTime(input.revision?.createdAt) &&
      [evidence.runCreatedAt, evidence.answersUpdatedAt].some((at) => validStateTime(at) !== null && compareCatalogTimes(at!, input.revision!.createdAt!) > 0),
  );
  const prework = new Set([work]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      const from = normalized(edge['from']);
      if (known.has(from) && !submitted.has(from) && !returnDestinations.has(from) && prework.has(normalized(edge['to'])) && forward(edge['trigger']) && !prework.has(from)) {
        prework.add(from);
        changed = true;
      }
    }
  }
  const retainedLocalWork =
    continuedWork &&
    revisionBefore === work &&
    revisionStatus === work &&
    input.currentStatusVerified === true &&
    input.projectWorkflowVerified === true &&
    prework.has(status) &&
    !returnDestinations.has(status);
  if ((clash && !continuedWork) || ((effectiveStatus !== work || status !== work) && !retainedLocalWork)) return 'unknown';
  if (input.reviewStatus === 'changes_requested') return 'review_return';
  if (input.reviewStatus === 'pending') return 'review';
  if (input.reviewStatus === 'approved') return (clash || retainedLocalWork) && !evidence?.reviewCurrent ? 'unknown' : 'approved';
  return input.assigned ? 'preparing' : 'unassigned';
}

export function pipelineFromListState(
  lane: CatalogListState,
  reviewStatus: 'pending' | 'approved' | 'changes_requested' | null,
): { stage: 'rubric' | 'review' | 'stability' | 'handoff' | 'done' | 'parked'; reviewStatus: 'pending' | 'approved' | 'changes_requested' | null; handoffStatus: 'bounced' | 'client_visible' | null } {
  switch (lane) {
    case 'submitted':
      return { stage: 'done', reviewStatus: reviewStatus === 'changes_requested' ? 'approved' : reviewStatus, handoffStatus: 'client_visible' };
    case 'platform_return':
      return { stage: 'handoff', reviewStatus: reviewStatus ?? 'approved', handoffStatus: 'bounced' };
    case 'approved':
      return { stage: 'stability', reviewStatus: 'approved', handoffStatus: null };
    case 'review':
      return { stage: 'review', reviewStatus: 'pending', handoffStatus: null };
    case 'review_return':
      return { stage: 'rubric', reviewStatus: 'changes_requested', handoffStatus: null };
    case 'preparing':
    case 'unassigned':
      return { stage: 'rubric', reviewStatus, handoffStatus: null };
    default:
      return { stage: 'parked', reviewStatus, handoffStatus: null };
  }
}
