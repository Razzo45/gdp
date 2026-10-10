/**
 * Per-seat file observation. The autorater may see only what this resolves:
 * the considered deliverable(s) and, when the seat is file-required, those
 * submitted inputs. Nothing is guessed from leftover attachments.
 *
 * A named file that does not resolve uniquely is an error, never a silent
 * fallback to the whole pool. `outputFile: null` with several deliverables
 * is the set-level case (the statement applies to every current output).
 */

export type StatementScope = 'output' | 'inputs';

export interface ScopeFile {
  id: string;
  name: string;
}

export interface SeatScope {
  scope: StatementScope;
  outputFile: string | null;
  inputFileIds: string[];
}

/** Curator chose the set-level observation (every current deliverable). */
export const ALL_OUTPUTS = '*';

export function isDefaultScope(seat: SeatScope): boolean {
  return seat.scope === 'output' && !seat.outputFile && seat.inputFileIds.length === 0;
}

export function isAllOutputs(token: string | null): boolean {
  return token === ALL_OUTPUTS;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function baseName(name: string): string {
  return normalized(name).replace(/\.[a-z0-9]{1,8}$/, '');
}

function genericLabel(name: string): boolean {
  return /^(input file|file|attachment|image|video|audio|document)\s*\d*$/i.test(name.trim());
}

/** Statement text must name the file (full name, or a basename of at least 6 characters). */
export function statementNamesFile(statement: string, file: ScopeFile): boolean {
  if (genericLabel(file.name)) return false;
  const text = normalized(statement);
  const full = normalized(file.name);
  const base = baseName(file.name);
  if (full.length >= 4 && text.includes(full)) return true;
  return base.length >= 6 && text.includes(base);
}

function uniqueMatches(statement: string, files: readonly ScopeFile[]): ScopeFile[] {
  const hits = files.filter((file) => statementNamesFile(statement, file));
  const ids = new Set(hits.map((file) => file.id));
  if (ids.size !== hits.length) return [];
  const labels = hits.map((file) => normalized(file.name));
  if (labels.some((label) => labels.filter((other) => other === label).length > 1)) return [];
  return hits;
}

export function inferFileScope(statement: string, inputs: readonly ScopeFile[], outputs: readonly ScopeFile[]): SeatScope {
  const namedInputs = uniqueMatches(statement, inputs);
  const namedOutputs = uniqueMatches(statement, outputs);
  const outputFile = namedOutputs.length === 1 ? namedOutputs[0]!.name : outputs.length === 1 ? outputs[0]!.name : null;
  if (namedInputs.length > 0) {
    return { scope: 'inputs', outputFile, inputFileIds: namedInputs.map((file) => file.id) };
  }
  return { scope: 'output', outputFile, inputFileIds: [] };
}

/**
 * Curator choices win. Default seats (output / no file / no inputs) pick up
 * a unique name match or the sole deliverable so factory rows still grade tight.
 */
export function applyInferredScope<T extends SeatScope & { statement: string }>(seat: T, inputs: readonly ScopeFile[], outputs: readonly ScopeFile[]): T {
  if (!isDefaultScope(seat)) {
    if (!seat.outputFile && outputs.length === 1) return { ...seat, outputFile: outputs[0]!.name };
    return seat;
  }
  return { ...seat, ...inferFileScope(seat.statement, inputs, outputs) };
}

/** Newest deliverable — last in the list (AI uploads are createdAt asc; Catalog goldens are current-last). */
export function latestOutput<T>(outputs: readonly T[]): T | undefined {
  return outputs[outputs.length - 1];
}

/**
 * Which output(s) to grade against right now.
 * A name in the statement still wins. "*" is every current file.
 * Otherwise the current/latest file is used — a replaced Golden or a newly
 * uploaded AI output is considered automatically; stale pins do not stick.
 */
export function consideredOutputs<T extends ScopeFile>(seat: SeatScope & { statement?: string }, outputs: readonly T[]): T[] {
  if (outputs.length === 0) return [];
  if (isAllOutputs(seat.outputFile)) return [...outputs];
  if (seat.statement) {
    const named = uniqueMatches(seat.statement, outputs);
    if (named.length === 1) return named;
  }
  const latest = latestOutput(outputs);
  return latest ? [latest] : [];
}

export function matchScopeFile<T extends ScopeFile>(files: readonly T[], token: string): T[] {
  const byId = files.filter((file) => file.id === token);
  if (byId.length === 1) return byId;
  const byName = files.filter((file) => file.name === token);
  if (byName.length === 1) return byName;
  return byId.length ? byId : byName;
}

export function resolveGradeFiles<T extends ScopeFile>(
  seat: SeatScope & { statement?: string },
  outputs: readonly T[],
  inputs: readonly T[],
): { ok: true; outputs: T[]; inputs: T[]; allOutputs: boolean } | { ok: false; error: string } {
  const selectedOutputs = consideredOutputs(seat, outputs);
  if (selectedOutputs.length === 0) {
    return { ok: false, error: 'No deliverable files were available to grade against.' };
  }
  const allOutputs = isAllOutputs(seat.outputFile) && outputs.length > 1;

  if (seat.scope === 'output') {
    if (seat.inputFileIds.length > 0) {
      return { ok: false, error: 'An output-only statement cannot require submitted inputs.' };
    }
    return { ok: true, outputs: selectedOutputs, inputs: [], allOutputs };
  }

  if (seat.inputFileIds.length === 0) {
    return { ok: false, error: 'This statement requires at least one submitted input.' };
  }
  if (new Set(seat.inputFileIds).size !== seat.inputFileIds.length) {
    return { ok: false, error: 'A submitted input is selected more than once.' };
  }
  const selectedInputs: T[] = [];
  for (const id of seat.inputFileIds) {
    const matches = matchScopeFile(inputs, id);
    if (matches.length !== 1) {
      return { ok: false, error: `Required input "${id}" is unavailable or ambiguous.` };
    }
    selectedInputs.push(matches[0]!);
  }
  return { ok: true, outputs: selectedOutputs, inputs: selectedInputs, allOutputs };
}

export function observationKey(files: { outputs: readonly ScopeFile[]; inputs: readonly ScopeFile[] }): string {
  const ids = (list: readonly ScopeFile[]) => list.map((file) => file.id).sort().join(',');
  return `o:${ids(files.outputs)}#i:${ids(files.inputs)}`;
}

export function describeSeatScope(seat: SeatScope & { statement?: string }, outputs: readonly ScopeFile[], inputs: readonly ScopeFile[]): string {
  const live = consideredOutputs(seat, outputs);
  const considered = isAllOutputs(seat.outputFile)
    ? 'all current deliverables'
    : live.length === 1
      ? live[0]!.name
      : live.length > 1
        ? 'all current deliverables'
        : 'the current deliverable';
  if (seat.scope === 'output') return `Against ${considered}`;
  const refs = seat.inputFileIds
    .map((id) => matchScopeFile(inputs, id)[0]?.name ?? id)
    .join(', ');
  return `Against ${considered} · vs ${refs || 'submitted inputs'}`;
}
