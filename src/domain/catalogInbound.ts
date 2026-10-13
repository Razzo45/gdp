import { catalogLooksInboundReady, submittedCatalogStatusIds, type CatalogListState, type CatalogStateInput } from './catalogListState';

/**
 * Catalog statuses that should move the GDP board: inbound pickup (K / E /
 * the watched work stage) and destinations Catalog uses when it sends a
 * submitted task back.
 */

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const normalized = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const returned = (trigger: unknown) =>
  ['revise', 'reject', 'revise-to-expert', 'revise-to-creator', 'send-to-rubric', 'send-to-rubrics'].includes(normalized(trigger));

export interface ListedCatalogSubmission {
  id: string;
  statusId: string | null;
  updatedAt?: string | null;
}

export function inboundWatchStatusIds(input: Pick<CatalogStateInput, 'workStatusId' | 'handoffStatusId' | 'inboundStatusIds' | 'statuses'>): Set<string> {
  const work = normalized(input.workStatusId);
  const handoff = normalized(input.handoffStatusId);
  const statuses = Array.isArray(input.statuses) ? input.statuses.map(object) : [];
  const inboundNamed = statuses
    .filter((entry) => catalogLooksInboundReady(typeof entry['name'] === 'string' ? entry['name'] : null))
    .map((entry) => normalized(entry['statusId']))
    .filter(Boolean);
  const extra = (input.inboundStatusIds ?? [])
    .map(normalized)
    .filter((id) => id && (id === work || inboundNamed.includes(id)));
  return new Set([work, ...inboundNamed, ...extra].filter((id) => id && id !== handoff));
}

export function returnWatchStatusIds(input: Pick<CatalogStateInput, 'workStatusId' | 'handoffStatusId' | 'statuses' | 'transitions'>): Set<string> {
  const submitted = submittedCatalogStatusIds(input);
  const watch = new Set<string>();
  for (const edge of Array.isArray(input.transitions) ? input.transitions.map(object) : []) {
    const to = normalized(edge['to']);
    if (submitted.has(normalized(edge['from'])) && to && returned(edge['trigger'])) watch.add(to);
  }
  return watch;
}

export function boardWatchStatusIds(input: Pick<CatalogStateInput, 'workStatusId' | 'handoffStatusId' | 'inboundStatusIds' | 'statuses' | 'transitions'>): Set<string> {
  return new Set([...inboundWatchStatusIds(input), ...returnWatchStatusIds(input)]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function catalogIdsToPull(
  listed: readonly ListedCatalogSubmission[],
  inboundStatusIds: ReadonlySet<string>,
  knownIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
  newWithinMs = DAY_MS,
  returnStatusIds: ReadonlySet<string> = new Set(),
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of listed) {
    const id = row.id.trim();
    const status = normalized(row.statusId);
    const inbound = inboundStatusIds.has(status);
    const returning = returnStatusIds.has(status);
    if (!id || seen.has(id) || !status || (!inbound && !returning)) continue;
    const known = knownIds.has(id);
    if (!known) {
      if (!inbound) continue;
      const updated = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
      if (!Number.isFinite(updated) || now - updated > newWithinMs) continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Submitted on GDP + Catalog back on pickup/return is a bounce, even when the log has no trigger. */
export function catalogLaneReopensSubmitted(lane: CatalogListState): boolean {
  return lane === 'platform_return' || lane === 'unassigned' || lane === 'preparing';
}

export function parseProjectSubmissionList(raw: unknown): { submissions: ListedCatalogSubmission[]; page: number; totalPages: number } {
  const body = object(raw);
  const rows = Array.isArray(body['data']) ? body['data'] : Array.isArray(raw) ? raw : [];
  const pagination = object(object(body['metadata'])['pagination']);
  const page = Number(pagination['page'] ?? 1);
  const totalPages = Number(pagination['totalPages'] ?? 1);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1,
    submissions: rows.flatMap((entry) => {
      const row = object(entry);
      const id = typeof row['projectSubmissionId'] === 'string' ? row['projectSubmissionId'].trim() : '';
      if (!id) return [];
      const status = object(row['workflowState'])['statusId'];
      const updatedAt = typeof row['updatedAt'] === 'string' ? row['updatedAt'] : null;
      return [{ id, statusId: typeof status === 'string' && status.trim() ? status.trim() : null, updatedAt }];
    }),
  };
}
