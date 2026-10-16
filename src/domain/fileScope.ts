/**
 * Per-seat file observation. The autorater may see only what this resolves:
 * the considered deliverable(s) and, when the seat is file-required, those
 * submitted inputs. Nothing is guessed from leftover attachments.
 *
 * Default (`outputFile` null / auto) is the current set — every Golden on
 * Golden autorate, every AI output on Stability. A statement that uniquely
 * names a file, or an explicit pin, narrows to that file. `*` is the same
 * set-level observation, kept as a curator override.
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
/** Output-only, current file — do not infer submitted inputs again. */
export const AUTO_OUTPUT = 'auto';
/** Virtual input: the Catalog task body (prompt/brief), not a file. */
export const TASK_BODY = 'task';
export const TASK_BODY_CHARS = 8_000;

export function isTaskBody(id: string): boolean {
  return id === TASK_BODY;
}

export function taskBodySelected(ids: readonly string[]): boolean {
  return ids.some(isTaskBody);
}

export function fileInputIds(ids: readonly string[]): string[] {
  return ids.filter((id) => !isTaskBody(id));
}

export function taskBodyPromptBlock(text: string): string | null {
  const body = text.trim();
  if (!body) return null;
  return body.length > TASK_BODY_CHARS ? `TASK BODY:\n${body.slice(0, TASK_BODY_CHARS)}\n…` : `TASK BODY:\n${body}`;
}

export function isDefaultScope(seat: SeatScope): boolean {
  return seat.scope === 'output' && !seat.outputFile && seat.inputFileIds.length === 0;
}

export function isAllOutputs(token: string | null): boolean {
  return token === ALL_OUTPUTS;
}

export function isAutoOutput(token: string | null): boolean {
  return token === AUTO_OUTPUT || token === null || token === '';
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

function uniqueMatches<T extends ScopeFile>(statement: string, files: readonly T[]): T[] {
  const hits = files.filter((file) => statementNamesFile(statement, file));
  const ids = new Set(hits.map((file) => file.id));
  if (ids.size !== hits.length) return [];
  const labels = hits.map((file) => normalized(file.name));
  if (labels.some((label) => labels.filter((other) => other === label).length > 1)) return [];
  return hits;
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at === -1 ? '' : name.slice(at + 1).toLowerCase();
}

function needsSubmittedInput(statement: string): boolean {
  if (/\b(workbook|spreadsheet|worksheet|excel|csv|brief|brand[- ]guide|style[- ]guide|source (file|doc)|input file|attached (brief|workbook|file|guide)|submitted input)\b/i.test(statement)) {
    return true;
  }
  if (/\b(policy|threshold|checklist|escalation|refund)\b/i.test(statement)) return true;
  const compares = /\b(match(?:es|ing)?|follow(?:s|ing)?|accord(?:ing)? to|per the|from the|against the)\b/i.test(statement);
  const data = /\b(figures?|numbers?|revenue|totals?|hex|colou?rs?|palette|font)\b/i.test(statement);
  return compares && data;
}

function matchInputsByKind(statement: string, inputs: readonly ScopeFile[]): ScopeFile[] {
  const wantSheet = /\b(workbook|spreadsheet|worksheet|excel|csv|figures?|revenue|numbers?|totals?|data)\b/i.test(statement);
  const wantDoc = /\b(brief|guide|policy|checklist|handbook|spec|threshold|escalation|refund|font|colou?r|palette|hex)\b/i.test(statement);
  return inputs.filter((file) => {
    const ext = extensionOf(file.name);
    if (wantSheet && /^(xlsx|xls|csv|ods)$/.test(ext)) return true;
    if (wantDoc && /^(docx|doc|pdf|rtf|txt)$/.test(ext)) return true;
    return false;
  });
}

function needsTaskBody(statement: string): boolean {
  return /\b(the brief|task body|the prompt|the instructions|as specified in the (task|brief|prompt))\b/i.test(statement);
}

function inferInputIds(statement: string, inputs: readonly ScopeFile[]): string[] {
  const named = uniqueMatches(statement, inputs);
  if (named.length > 0) return named.map((file) => file.id);
  const wantsInput = needsSubmittedInput(statement) || needsTaskBody(statement);
  if (!wantsInput) return [];
  const byKind = matchInputsByKind(statement, inputs);
  if (byKind.length > 0) return byKind.map((file) => file.id);
  if (needsTaskBody(statement) || /\bbrief\b/i.test(statement)) return [TASK_BODY];
  if (inputs.length === 0) return [];
  if (inputs.length === 1 || inputs.length <= 3) return inputs.map((file) => file.id);
  return [];
}

export function inferFileScope(statement: string, inputs: readonly ScopeFile[], outputs: readonly ScopeFile[]): SeatScope {
  const namedOutputs = uniqueMatches(statement, outputs);
  const outputFile = namedOutputs.length === 1 && outputs.length > 1 ? namedOutputs[0]!.name : null;
  const inputFileIds = inferInputIds(statement, inputs);
  return { scope: inputFileIds.length > 0 ? 'inputs' : 'output', outputFile, inputFileIds };
}

/**
 * Golden vs AI is chosen by the job, not the seat. Default and sole-file pins
 * pick up named / implied submitted inputs. Explicit overrides stay put.
 */
export function applyInferredScope<T extends SeatScope & { statement: string }>(seat: T, inputs: readonly ScopeFile[], outputs: readonly ScopeFile[]): T {
  const inferred = inferFileScope(seat.statement, inputs, outputs);
  const soleName = outputs.length === 1 ? outputs[0]!.name : null;
  const automatic =
    isDefaultScope(seat) ||
    (seat.scope === 'output' && seat.inputFileIds.length === 0 && (isAutoOutput(seat.outputFile) || seat.outputFile === soleName));

  if (seat.outputFile === AUTO_OUTPUT) return seat;
  if (isAllOutputs(seat.outputFile)) {
    if (seat.inputFileIds.length > 0) return seat;
    return { ...seat, scope: inferred.scope, inputFileIds: inferred.inputFileIds };
  }
  if (!automatic) return seat;
  return { ...seat, ...inferred };
}

/** Newest deliverable — last in the list (AI uploads are createdAt asc; Catalog goldens are current-last). */
export function latestOutput<T>(outputs: readonly T[]): T | undefined {
  return outputs[outputs.length - 1];
}

/**
 * Which output(s) to grade against right now.
 * A unique name in the statement still wins. An explicit pin wins next.
 * Otherwise the whole current set is graded (any one fail → No).
 */
export function consideredOutputs<T extends ScopeFile>(seat: SeatScope & { statement?: string }, outputs: readonly T[]): T[] {
  if (outputs.length === 0) return [];
  if (isAllOutputs(seat.outputFile)) return [...outputs];
  const named = seat.statement ? uniqueMatches(seat.statement, outputs) : [];
  if (named.length === 1) return named;
  if (named.length > 1) return named;
  if (!isAutoOutput(seat.outputFile) && seat.outputFile) {
    const pinned = matchScopeFile(outputs, seat.outputFile);
    if (pinned.length === 1) return pinned;
  }
  return [...outputs];
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
): { ok: true; outputs: T[]; inputs: T[]; allOutputs: boolean; taskBody: boolean } | { ok: false; error: string } {
  const selectedOutputs = consideredOutputs(seat, outputs);
  if (selectedOutputs.length === 0) {
    return { ok: false, error: 'No deliverable files were available to grade against.' };
  }
  const allOutputs = selectedOutputs.length > 1 && selectedOutputs.length === outputs.length;
  const taskBody = taskBodySelected(seat.inputFileIds);
  const requiredFiles = fileInputIds(seat.inputFileIds);

  if (seat.scope === 'output') {
    if (requiredFiles.length > 0 || taskBody) {
      return { ok: false, error: 'An output-only statement cannot require submitted inputs.' };
    }
    return { ok: true, outputs: selectedOutputs, inputs: [], allOutputs, taskBody: false };
  }

  if (requiredFiles.length === 0 && !taskBody) {
    return { ok: false, error: 'This statement requires at least one submitted input.' };
  }
  if (new Set(seat.inputFileIds).size !== seat.inputFileIds.length) {
    return { ok: false, error: 'A submitted input is selected more than once.' };
  }
  const selectedInputs: T[] = [];
  for (const id of requiredFiles) {
    const matches = matchScopeFile(inputs, id);
    if (matches.length !== 1) {
      return { ok: false, error: `Required input "${id}" is unavailable or ambiguous.` };
    }
    selectedInputs.push(matches[0]!);
  }
  return { ok: true, outputs: selectedOutputs, inputs: selectedInputs, allOutputs, taskBody };
}

export function observationKey(files: { outputs: readonly ScopeFile[]; inputs: readonly ScopeFile[]; taskBody?: boolean }): string {
  const ids = (list: readonly ScopeFile[]) => list.map((file) => file.id).sort().join(',');
  return `o:${ids(files.outputs)}#i:${ids(files.inputs)}${files.taskBody ? '#t:1' : ''}`;
}

export function describeSeatScope(seat: SeatScope & { statement?: string }, outputs: readonly ScopeFile[], inputs: readonly ScopeFile[]): string {
  const selected = consideredOutputs(seat, outputs);
  const lane =
    selected.length > 1
      ? 'Golden autorate uses every Golden file. Stability uses every AI output.'
      : 'Golden autorate uses the Golden file. Stability uses the AI output.';
  if (seat.scope !== 'inputs' || seat.inputFileIds.length === 0) return lane;
  const refs = seat.inputFileIds
    .map((id) => (isTaskBody(id) ? 'the task body' : (matchScopeFile(inputs, id)[0]?.name ?? id)))
    .filter(Boolean)
    .join(', ');
  return `${lane} Also reads ${refs || 'submitted inputs'}.`;
}
