import 'server-only';

import { z } from 'zod';
import { acceptancePromptBlock, applyInferredScope, observationKey, resolveGradeFiles, taskBodyPromptBlock } from '@/domain/fileScope';
import { env } from '@/lib/env';
import { GeminiError, generateJson, tightenSendParts, type MediaPart } from '@/lib/ai/gemini';
import type { PreparedFile } from '@/lib/ai/media';

/**
 * The autorater. Grades Precise Boolean statements against a frozen
 * observation: the considered deliverable(s) and only the inputs that seat
 * required. Same rule as legacy, with three enhancements:
 *  - Seats that share that observation are graded in one structured call.
 *  - Default seats pick up a unique filename match (or the sole deliverable)
 *    so factory rows stay tight without a silent dump of every attachment.
 *  - A named file that does not resolve is an error, never extra evidence.
 */

const GRADE_CONTEXT_CHARS = 800;

export interface GradeStatement {
  id: string;
  /** Global seat 1…N (Format then Content then Visual). Sent to the model as s001. */
  seat?: number;
  statement: string;
  tag: string;
  scope: 'output' | 'inputs';
  inputFileIds: string[];
  outputFile: string | null;
}

export interface GradeInput {
  statements: GradeStatement[];
  /** The deliverables being judged (golden or AI output). */
  outputs: PreparedFile[];
  /** Task inputs that statements may reference by file id. */
  inputs: PreparedFile[];
  taskContext: string;
  /** Full Catalog brief, attached only when a seat links the task body. */
  taskBody?: string;
  /** Catalog acceptance criteria (+ additional), attached only when a seat links them. */
  acceptanceCriteria?: string;
  /** Pre-computed defect inventory, shared across stability passes. */
  defectInventory?: string[];
  /** Per-observation inventory reused across Stability passes. */
  inventoryByKey?: Record<string, string[]>;
  model?: string;
  temperature?: number;
  onBatch?: (partial: GradeResult) => Promise<void> | void;
  /** Seats per Gemini call. Stability leaves this unset so each seat is graded alone. */
  batchSize?: number;
  /** Archive/video Stability grades one batch at a time so a zip cannot fan out ten full-site prompts. */
  serialBatches?: boolean;
}

export interface GradeResult {
  answers: Record<string, boolean>;
  evidence: Record<string, string>;
  errors: Record<string, string>;
  model: string;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number; calls: number };
  defectInventory: string[];
  inventoryByKey: Record<string, string[]>;
}

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      answer: z.enum(['Yes', 'No']),
      evidence: z.string(),
    }),
  ),
});

const Inventory = z.object({ defects: z.array(z.string()).max(18) });

/** Enough tokens for the model to inspect before it answers. 0 was a blurt. */
export const AUTORATE_THINKING_BUDGET = 2048;
export const INVENTORY_UNAVAILABLE = '__inventory_unavailable__';

export const AUTORATER_SYSTEM = `You are a rubric autorater. You have no preference for Yes or No, no target
score, and you do not know or care whether the file is a Golden or an AI output.
Grade the statement as written against the attached files only.

You will be shown numbered affirmative statements and the FILES they are graded
against: CONSIDERED OUTPUT attachments (the work being judged) and, when relevant,
SUBMITTED INPUT attachments. Treat the attachments and any FILE FACTS / text
digests as the files themselves. Think through each claim before you answer.
A TASK BODY or ACCEPTANCE CRITERIA block is reference text from the task: use it
to know what was required, never as evidence that the output delivers it.

Grade EVERY statement independently, as if it were sent alone. Shared files
are not shared verdicts. Do not carry a Yes or a No from a neighbouring seat,
do not keep a running score, and do not pattern-match the list. For each,
answer exactly Yes or No and give ONE SENTENCE of evidence citing the specific
element of the attached files you used.

Yes = you located the claim on the files and confirmed it holds.
No = the statement does not hold, OR you cannot verify it from the files.
Never answer N/A. Every statement always applies. An unverified claim is No.
A close-enough, partial, paraphrased or probable Yes is a No.

Rules:
- Answer only the claim in that statement. Do not fail extra faults the statement
  did not ask about. Do not pass a claim you did not verify.
- Do not invent content that is not evidenced; do not deny content that is
  plainly present in an attachment or digest.
- If a statement names a specific file, evaluate that file (match by filename even
  if the path differs slightly).
- INSPECT attached images, video, audio, PDF and rendered slide/page stills.
  Prefer what you see/hear over a text summary when they conflict. A slide still
  labelled "slide N" is that page of the deck.
- JPEG or PDF attachments labelled as slide/page stills or a PDF render of a
  PPTX/DOCX/XLSX are views of that Office file. FILE FACTS Kind is the
  deliverable format. Do not answer that the file is a JPEG rather than a PPTX.
  Packaged slide/page size and aspect come from FILE FACTS, not from a still's
  pixel dimensions.
- For video/audio: only claim events, dialogue or specs evidenced in the clip.
  If you did not hear the required words or see the required beat, answer No.
  Exact wording: a paraphrase is a No.
- Logical consistency is mandatory: the Yes/No MUST agree with the evidence sentence.
- "rather than X" / "instead of X" / "free of X" / "contains no X": Yes only after
  you inspect the full deliverable and X is absent. If you cannot review the full
  timeline, answer No. One instance of X is No.
- If a statement requires a measurement (dimension, ratio, count, duration,
  contrast, codec, colour space, loudness), state the measured value in the
  evidence. Yes only when FILE FACTS or a visible on-screen readout give that
  value. Do not infer H.264, Rec.709, peak levels or duration by eye.
- Container / metadata 16:9 is not proof the picture fills the frame. Letterboxing,
  pillarboxing, clipping and safe-area claims are judged from the picture, not
  the file header.
- Do not answer probabilistically. Do not invent canvas sizes, colours or contrast
  failures that contradict the attachment.
- NAMING WHAT YOU PERCEIVE: do not assert labels the deliverable does not clearly
  show. If unsure what an element is, describe it neutrally and answer No if the
  claim depends on that label.
- Judge only what you can verify on the files. "Looks fine" is not Yes.
- SUBMITTED INPUTS: when a statement requires fidelity to them, compare the
  deliverable to those refs. Overall impression is not a match.
- VERIFICATION BURDEN: a correspondence claim may only be Yes after you locate
  the corresponding elements on BOTH sides.
- Your evidence must describe THE DELIVERABLE. Restating the brief is not evidence.
- COMPOSITE/COLLAGE: pasted insets, swatch strips, cutout photos or moodboard
  elements ARE part of the deliverable when the statement is about the finished work.
- Soft presence is not enough when the statement requires a match, a measurement
  or a free-of check.
- MULTIPLE DELIVERABLES: if a statement applies to all deliverables and any one
  of them fails the claim, answer No.
- DEFECT_INVENTORY: use a listed defect only when it actually falsifies this
  statement. An unavailable inventory is not proof the file is clean.
- A file marked NOT ATTACHED cannot support a Yes on a statement that depends on
  that file; answer No and say why.
- FILE FACTS are authoritative for file size, slide/page counts, packaged aspect, fonts,
  embedded-media presence, duration, codec, channel layout, loudness, peak/RMS
  level, left-right channel level difference, clipping, silence gaps, stereo
  correlation, DC offset and bit depth. They do not decide picture-level
  letterboxing, colour look, or spoken content. Use the FILE FACTS file-size line
  for any MB/KB size claim; do not infer size from page count or how "lightweight"
  the document looks. Use the FILE FACTS loudness / channel-level / clipping /
  silence / stereo lines for those claims; do not guess them by ear.
- Embedded images attached after NO FULL-PAGE RENDER may support photograph/asset
  claims. Format, slide/page count and packaged size still come from FILE FACTS.
  For slide-level layout, spacing or typography you cannot see, the statement
  does not hold.
- If the files do not show the claimed property, or you cannot verify it, the
  statement does not hold. Do not guess it in to make Yes. Do not invent a
  defect to make No.

Return JSON only: { "verdicts": [ { "id": "<seat id like s008>", "answer": "Yes" | "No", "evidence": "<one sentence>" } ] }
Include every seat id exactly once. Put the seat id only in "id". Evidence describes the deliverable only — do not write Seat 8, s008, or a UUID in the evidence sentence.`;

export function inventoryPromptBlock(inventory: string[]): string | null {
  if (inventory.includes(INVENTORY_UNAVAILABLE)) {
    return 'DEFECT_INVENTORY: unavailable. Do not treat the deliverable as clean. Verify each statement from the attached files only.';
  }
  const defects = inventory.map((row) => row.trim()).filter((row) => row && row !== INVENTORY_UNAVAILABLE);
  if (!defects.length) return null;
  return `DEFECT_INVENTORY:\n${defects.map((row) => `- ${row}`).join('\n')}`;
}

const INVENTORY_SYSTEM = `You inspect CONSIDERED OUTPUT attachments (and any SUBMITTED INPUT attachments).
List concrete, falsifiable defects you can actually see. You have no preference
for finding defects or calling the file clean.

Return JSON only: { "defects": [ "<short defect>", ... ] } with at most 18 items, or
{ "defects": [] } if you looked and found none.

Include a defect only when it is clearly visible, for example:
- collage / moodboard / swatch strip / cutout product photos sold as a finished view
- layout mismatch vs SUBMITTED INPUT (wrong counts, mirrored or rearranged zones)
- floating objects, clipping, ungrounded geometry
- garbled AI text / melted letterforms
- wrong materials or palette vs brief/reference when obvious
- unfinished / composite sheet where a clean finished artifact was required

Do NOT invent defects. Do NOT praise. Judge only from what is actually evidenced;
a text digest is a partial view, not proof of truncation or missing content.`;

interface Briefs {
  taskBody?: string;
  acceptanceCriteria?: string;
}

/** Only the virtual inputs this observation selected. */
function briefsFor(selection: { taskBody: boolean; acceptance: boolean }, input: Briefs): Briefs {
  return {
    taskBody: selection.taskBody ? input.taskBody : undefined,
    acceptanceCriteria: selection.acceptance ? (input.acceptanceCriteria ?? '') : undefined,
  };
}

function evidenceParts(
  files: { outputs: PreparedFile[]; inputs: PreparedFile[] },
  taskContext: string,
  inventory: string[],
  allOutputs: boolean,
  briefs: Briefs = {},
): (string | MediaPart)[] {
  const parts: (string | MediaPart)[] = [];
  const context = taskContext.trim();
  if (context) parts.push(`TASK CONTEXT:\n${context.length > GRADE_CONTEXT_CHARS ? `${context.slice(0, GRADE_CONTEXT_CHARS)}\n…` : context}`);
  const body = briefs.taskBody ? taskBodyPromptBlock(briefs.taskBody) : null;
  if (body) parts.push(body);
  if (briefs.acceptanceCriteria !== undefined) parts.push(acceptancePromptBlock(briefs.acceptanceCriteria));
  parts.push(`CONSIDERED_OUTPUTS${allOutputs ? ' (every current deliverable; any one fail → No)' : ''}: ${files.outputs.map((f) => f.name).join(', ') || '(none)'}`);
  if (files.inputs.length) parts.push(`SUBMITTED_INPUTS: ${files.inputs.map((f) => f.name).join(', ')}`);
  const inventoryBlock = inventoryPromptBlock(inventory);
  if (inventoryBlock) parts.push(inventoryBlock);
  for (const file of files.outputs) parts.push(...file.parts);
  for (const file of files.inputs) parts.push(...file.parts);
  return tightenSendParts(parts);
}

function promptId(s: GradeStatement): string {
  return typeof s.seat === 'number' && s.seat > 0 ? `s${String(s.seat).padStart(3, '0')}` : s.id;
}

function matchStatement(batch: GradeStatement[], verdictId: string): GradeStatement | undefined {
  const compact = verdictId.trim().replace(/^seat\s+/i, '');
  return batch.find((s) => s.id === verdictId || promptId(s) === verdictId || (s.seat !== undefined && (String(s.seat) === compact || promptId(s) === compact)));
}

export function statementsBlock(statements: GradeStatement[]): string {
  const isolation =
    statements.length > 1
      ? 'ISOLATE EACH STATEMENT. Grade each bracketed id as if it were sent alone. Do not reuse a verdict, evidence sentence, or score from a neighbouring line. A Yes on one seat is not evidence for another.\n'
      : '';
  return `${isolation}STATEMENTS TO GRADE (${statements.length}):\n${statements.map((s) => `[${promptId(s)}] (${s.tag}) ${s.statement}`).join('\n')}`;
}

/** One inventory per distinct observation, reused across Stability passes. */
export async function inventoriesForObservations(input: GradeInput): Promise<Record<string, string[]>> {
  const byKey: Record<string, string[]> = { ...(input.inventoryByKey ?? {}) };
  const outputRefs = input.outputs.map((f) => ({ id: f.id, name: f.name }));
  const inputRefs = input.inputs.map((f) => ({ id: f.id, name: f.name }));
  for (const raw of input.statements) {
    const statement = applyInferredScope(raw, inputRefs, outputRefs);
    const selection = resolveGradeFiles(statement, input.outputs, input.inputs);
    if (!selection.ok) continue;
    const key = observationKey(selection);
    if (byKey[key]) continue;
    byKey[key] = await defectInventory({
      outputs: selection.outputs,
      inputs: selection.inputs,
      taskContext: input.taskContext,
      ...briefsFor(selection, input),
      model: input.model,
    });
  }
  return byKey;
}

export async function defectInventory(input: Pick<GradeInput, 'outputs' | 'inputs' | 'taskContext' | 'taskBody' | 'acceptanceCriteria' | 'model'>): Promise<string[]> {
  if (input.outputs.length === 0) return [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await generateJson({
        model: input.model,
        system: INVENTORY_SYSTEM,
        parts: evidenceParts({ outputs: input.outputs, inputs: input.inputs }, input.taskContext, [], input.outputs.length > 1, { taskBody: input.taskBody, acceptanceCriteria: input.acceptanceCriteria }),
        schema: Inventory,
        temperature: 0.1,
        maxOutputTokens: 2048,
        thinkingBudget: AUTORATE_THINKING_BUDGET,
      });
      return result.value.defects.map((d) => d.trim()).filter(Boolean);
    } catch {
      if (attempt === 2) return [INVENTORY_UNAVAILABLE];
    }
  }
  return [INVENTORY_UNAVAILABLE];
}

export async function gradeStatements(input: GradeInput): Promise<GradeResult> {
  const model = input.model ?? env().GEMINI_MODEL;
  const batchSize = input.batchSize ?? env().AUTORATE_BATCH_SIZE;
  const result: GradeResult = {
    answers: {},
    evidence: {},
    errors: {},
    model,
    usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 },
    defectInventory: input.defectInventory ?? [],
    inventoryByKey: { ...(input.inventoryByKey ?? {}) },
  };
  if (input.outputs.length === 0) {
    for (const s of input.statements) result.errors[s.id] = 'No deliverable files were available to grade against.';
    return result;
  }

  const outputRefs = input.outputs.map((f) => ({ id: f.id, name: f.name }));
  const inputRefs = input.inputs.map((f) => ({ id: f.id, name: f.name }));
  const resolved = new Map<string, { statement: GradeStatement; files: { outputs: PreparedFile[]; inputs: PreparedFile[] }; allOutputs: boolean; briefs: Briefs; key: string }>();
  for (const raw of input.statements) {
    const statement = applyInferredScope(raw, inputRefs, outputRefs);
    const selection = resolveGradeFiles(statement, input.outputs, input.inputs);
    if (!selection.ok) {
      result.errors[raw.id] = selection.error;
      continue;
    }
    const key = observationKey(selection);
    resolved.set(raw.id, { statement, files: { outputs: selection.outputs, inputs: selection.inputs }, allOutputs: selection.allOutputs, briefs: briefsFor(selection, input), key });
  }

  const groups = new Map<string, GradeStatement[]>();
  for (const entry of resolved.values()) {
    groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry.statement]);
  }
  const batches: GradeStatement[][] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += batchSize) batches.push(group.slice(i, i + batchSize));
  }

  const gradeBatch = async (batch: GradeStatement[]): Promise<void> => {
    const entry = resolved.get(batch[0]!.id)!;
    const files = entry.files;
    if (!result.inventoryByKey[entry.key]) {
      result.inventoryByKey[entry.key] = input.defectInventory ?? (await defectInventory({ outputs: files.outputs, inputs: files.inputs, taskContext: input.taskContext, ...entry.briefs, model }));
    }
    const inventory = result.inventoryByKey[entry.key] ?? [];
    result.defectInventory = [...new Set([...result.defectInventory, ...inventory.filter((row) => row !== INVENTORY_UNAVAILABLE)])];
    const parts = [...evidenceParts(files, input.taskContext, inventory, entry.allOutputs, entry.briefs), statementsBlock(batch)];
    const wanted = new Set(batch.map((s) => s.id));
    try {
      const response = await generateJson({ model, system: AUTORATER_SYSTEM, parts, schema: Verdicts, temperature: input.temperature ?? 0.2, maxOutputTokens: 8192, thinkingBudget: AUTORATE_THINKING_BUDGET });
      record(result, response);
      for (const verdict of response.value.verdicts) {
        const statement = matchStatement(batch, verdict.id);
        if (!statement || !wanted.has(statement.id)) continue;
        const evidence = verdict.evidence.trim();
        if (!evidence) continue;
        result.answers[statement.id] = verdict.answer === 'Yes';
        result.evidence[statement.id] = evidence;
        wanted.delete(statement.id);
      }
    } catch (error) {
      const message = error instanceof GeminiError ? error.message : 'Grading failed.';
      if (error instanceof GeminiError && (error.kind === 'rate_limit' || error.kind === 'storage_full' || error.kind === 'auth' || error.kind === 'not_configured' || error.kind === 'too_large')) {
        for (const id of wanted) result.errors[id] = message;
        await input.onBatch?.(result);
        return;
      }
    }
    // Statements the model skipped (or a failed batch) are retried alone, once.
    for (const id of wanted) {
      const statement = batch.find((s) => s.id === id)!;
      try {
        const response = await generateJson({ model, system: AUTORATER_SYSTEM, parts: [...parts.slice(0, -1), statementsBlock([statement])], schema: Verdicts, temperature: input.temperature ?? 0.2, maxOutputTokens: 1024, thinkingBudget: AUTORATE_THINKING_BUDGET });
        record(result, response);
        const verdict = response.value.verdicts.find((v) => matchStatement([statement], v.id)) ?? response.value.verdicts[0];
        if (!verdict) throw new GeminiError('invalid_output', 'Gemini returned no verdict for the statement.');
        const evidence = verdict.evidence.trim();
        if (!evidence) throw new GeminiError('invalid_output', 'Gemini returned a verdict with no evidence.');
        result.answers[id] = verdict.answer === 'Yes';
        result.evidence[id] = evidence;
      } catch (error) {
        result.errors[id] = error instanceof GeminiError ? error.message : 'Grading failed.';
      }
    }
    await input.onBatch?.(result);
  };

  if (input.serialBatches) {
    for (const batch of batches) await gradeBatch(batch);
  } else {
    await Promise.all(batches.map(gradeBatch));
  }
  return result;
}

function record(result: GradeResult, response: { usage: { promptTokens: number; outputTokens: number; totalTokens: number } }): void {
  result.usage.calls += 1;
  result.usage.promptTokens += response.usage.promptTokens;
  result.usage.outputTokens += response.usage.outputTokens;
  result.usage.totalTokens += response.usage.totalTokens;
}
