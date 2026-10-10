import 'server-only';

import { z } from 'zod';
import { applyInferredScope, observationKey, resolveGradeFiles } from '@/domain/fileScope';
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
  /** Pre-computed defect inventory, shared across stability passes. */
  defectInventory?: string[];
  /** Per-observation inventory reused across Stability passes. */
  inventoryByKey?: Record<string, string[]>;
  model?: string;
  temperature?: number;
  onBatch?: (partial: GradeResult) => Promise<void> | void;
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

export const AUTORATER_SYSTEM = `You are a strict rubric autorater. You will be shown a numbered list of
affirmative statements and the FILES they are graded against: CONSIDERED OUTPUT
attachments (the work being judged) and, when relevant, SUBMITTED INPUT
attachments (the brief's source material). Treat the attachments and any
FILE FACTS / text digests as the files themselves.

Grade EVERY statement independently. For each, answer exactly Yes or No and give
ONE SENTENCE of evidence citing the specific element of the attached files you used.

Yes = the statement is true / holds for the deliverable.
No = the statement is false.

Never answer N/A. Every statement always applies. If something optional is
absent, answer No only when the statement required it; otherwise judge the
criterion as written on what is present.

Rules:
- Answer strictly against the attached files. Do not invent content that is not
  evidenced; do not deny content that is plainly present in an attachment or digest.
- If a statement names a specific file, evaluate that file (match by filename even
  if the path differs slightly).
- INSPECT attached images, video, audio and PDF. Prefer what you see/hear over a
  text summary when they conflict.
- For video/audio: only claim events, dialogue or specs evidenced in the clip.
- Logical consistency is mandatory: the Yes/No MUST agree with the evidence sentence.
- "rather than X" / "instead of X" / "free of X": if X is absent and the positive
  alternative is present, answer Yes — but only when the statement's sole claim is
  that contrast. If it ALSO asserts a positive match (to a reference, plan, count,
  measurement or named property), absence of X alone is never enough: verify the
  positive claim. If you cannot verify it, answer No.
- If a statement requires a measurement (dimension, ratio, count, duration,
  contrast), state the measured value in the evidence. FILE FACTS blocks are
  authoritative for counts, sizes, aspect ratios, fonts and embedded media.
- Do not answer probabilistically. Do not invent canvas sizes, colours or contrast
  failures that contradict the attachment.
- NAMING WHAT YOU PERCEIVE: do not assert labels the deliverable does not clearly
  show. If unsure what an element is, describe it neutrally.
- Do not assume a clean idealised version of the deliverable when the attachment
  plainly contains defects — judge what is actually there.
- FAILURE MODES: answer No when the deliverable shows a defect a competent
  professional in this field would reject, even if it is otherwise polished.
- SUBMITTED INPUTS: when a statement requires fidelity to them, compare the
  deliverable to those refs — never answer Yes from the deliverable's overall
  impression alone.
- VERIFICATION BURDEN: a statement asserting correspondence — to a SUBMITTED INPUT,
  across files, or between elements — may only be Yes after you locate the
  corresponding elements on BOTH sides. "Looks plausible" is not verification.
- Your evidence must describe THE DELIVERABLE. Restating the brief or the
  reference is not evidence of anything.
- COMPOSITE/COLLAGE: pasted insets, swatch strips, cutout photos or moodboard
  elements ARE part of the deliverable. When a finished artifact was required,
  count them as defects, not decor.
- Soft presence is not enough: "something of that kind is present" does not
  satisfy a statement that requires a match, a measurement or a free-of check.
- MULTIPLE DELIVERABLES: if a statement applies to all deliverables and any one
  of them fails the claim, answer No.
- DEFECT_INVENTORY: any listed defect that falsifies a statement → No.
- A file marked NOT ATTACHED or NO RENDER AVAILABLE cannot support a Yes on a
  statement that depends on what is missing; answer No and say why.
- UNCERTAINTY: if you cannot verify the hard half of a claim from the
  attachments, answer No — never Yes on a guess.

Return JSON only: { "verdicts": [ { "id": "<seat id like s008>", "answer": "Yes" | "No", "evidence": "<one sentence>" } ] }
Include every seat id exactly once. Refer to seats as Seat 8 in evidence, never as a UUID.`;

const INVENTORY_SYSTEM = `You inspect CONSIDERED OUTPUT attachments (and any SUBMITTED INPUT attachments) for a
foundation-model eval. List concrete, falsifiable defects a competent professional
would reject — even if the output looks polished.

Return JSON only: { "defects": [ "<short defect>", ... ] } with at most 18 items, or
{ "defects": [] } if clean.

Include defects when clearly visible, for example:
- collage / moodboard / swatch strip / cutout product photos sold as a finished view
- layout mismatch vs SUBMITTED INPUT (wrong counts, mirrored or rearranged zones)
- floating objects, clipping, ungrounded geometry
- garbled AI text / melted letterforms
- wrong materials or palette vs brief/reference when obvious
- unfinished / composite sheet where a clean finished artifact was required

Do NOT invent defects. Do NOT praise. Judge only from what is actually evidenced;
a text digest is a partial view, not proof of truncation or missing content.`;

function evidenceParts(files: { outputs: PreparedFile[]; inputs: PreparedFile[] }, taskContext: string, inventory: string[], allOutputs: boolean): (string | MediaPart)[] {
  const parts: (string | MediaPart)[] = [];
  const context = taskContext.trim();
  if (context) parts.push(`TASK CONTEXT:\n${context.length > GRADE_CONTEXT_CHARS ? `${context.slice(0, GRADE_CONTEXT_CHARS)}\n…` : context}`);
  parts.push(`CONSIDERED_OUTPUTS${allOutputs ? ' (every current deliverable; any one fail → No)' : ''}: ${files.outputs.map((f) => f.name).join(', ') || '(none)'}`);
  if (files.inputs.length) parts.push(`SUBMITTED_INPUTS: ${files.inputs.map((f) => f.name).join(', ')}`);
  if (inventory.length) parts.push(`DEFECT_INVENTORY:\n${inventory.map((d) => `- ${d}`).join('\n')}`);
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

function statementsBlock(statements: GradeStatement[]): string {
  return `STATEMENTS TO GRADE (${statements.length}):\n${statements.map((s) => `[${promptId(s)}] ${s.seat ? `Seat ${s.seat} · ` : ''}(${s.tag}) ${s.statement}`).join('\n')}`;
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
    byKey[key] = await defectInventory({ outputs: selection.outputs, inputs: selection.inputs, taskContext: input.taskContext, model: input.model });
  }
  return byKey;
}

export async function defectInventory(input: Pick<GradeInput, 'outputs' | 'inputs' | 'taskContext' | 'model'>): Promise<string[]> {
  if (input.outputs.length === 0) return [];
  try {
    const result = await generateJson({
      model: input.model,
      system: INVENTORY_SYSTEM,
      parts: evidenceParts({ outputs: input.outputs, inputs: input.inputs }, input.taskContext, [], input.outputs.length > 1),
      schema: Inventory,
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
    return result.value.defects.map((d) => d.trim()).filter(Boolean);
  } catch {
    // The inventory is an aid, not a gate. Grading proceeds without it.
    return [];
  }
}

export async function gradeStatements(input: GradeInput): Promise<GradeResult> {
  const model = input.model ?? env().GEMINI_MODEL;
  const batchSize = env().AUTORATE_BATCH_SIZE;
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
  const resolved = new Map<string, { statement: GradeStatement; files: { outputs: PreparedFile[]; inputs: PreparedFile[] }; allOutputs: boolean; key: string }>();
  for (const raw of input.statements) {
    const statement = applyInferredScope(raw, inputRefs, outputRefs);
    const selection = resolveGradeFiles(statement, input.outputs, input.inputs);
    if (!selection.ok) {
      result.errors[raw.id] = selection.error;
      continue;
    }
    const key = observationKey(selection);
    resolved.set(raw.id, { statement, files: { outputs: selection.outputs, inputs: selection.inputs }, allOutputs: selection.allOutputs, key });
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
      result.inventoryByKey[entry.key] = input.defectInventory ?? (await defectInventory({ outputs: files.outputs, inputs: files.inputs, taskContext: input.taskContext, model }));
    }
    const inventory = result.inventoryByKey[entry.key] ?? [];
    result.defectInventory = [...new Set([...result.defectInventory, ...inventory])];
    const parts = [...evidenceParts(files, input.taskContext, inventory, entry.allOutputs), statementsBlock(batch)];
    const wanted = new Set(batch.map((s) => s.id));
    try {
      const response = await generateJson({ model, system: AUTORATER_SYSTEM, parts, schema: Verdicts, temperature: input.temperature ?? 0.2, maxOutputTokens: 8192, thinkingBudget: 0 });
      record(result, response);
      for (const verdict of response.value.verdicts) {
        const statement = matchStatement(batch, verdict.id);
        if (!statement || !wanted.has(statement.id)) continue;
        result.answers[statement.id] = verdict.answer === 'Yes';
        result.evidence[statement.id] = verdict.evidence.trim();
        wanted.delete(statement.id);
      }
    } catch (error) {
      const message = error instanceof GeminiError ? error.message : 'Grading failed.';
      if (error instanceof GeminiError && (error.kind === 'rate_limit' || error.kind === 'auth' || error.kind === 'not_configured' || error.kind === 'too_large')) {
        for (const id of wanted) result.errors[id] = message;
        await input.onBatch?.(result);
        return;
      }
    }
    // Statements the model skipped (or a failed batch) are retried alone, once.
    for (const id of wanted) {
      const statement = batch.find((s) => s.id === id)!;
      try {
        const response = await generateJson({ model, system: AUTORATER_SYSTEM, parts: [...parts.slice(0, -1), statementsBlock([statement])], schema: Verdicts, temperature: input.temperature ?? 0.2, maxOutputTokens: 1024, thinkingBudget: 0 });
        record(result, response);
        const verdict = response.value.verdicts.find((v) => matchStatement([statement], v.id)) ?? response.value.verdicts[0];
        if (!verdict) throw new GeminiError('invalid_output', 'Gemini returned no verdict for the statement.');
        result.answers[id] = verdict.answer === 'Yes';
        result.evidence[id] = verdict.evidence.trim();
      } catch (error) {
        result.errors[id] = error instanceof GeminiError ? error.message : 'Grading failed.';
      }
    }
    await input.onBatch?.(result);
  };

  await Promise.all(batches.map(gradeBatch));
  return result;
}

function record(result: GradeResult, response: { usage: { promptTokens: number; outputTokens: number; totalTokens: number } }): void {
  result.usage.calls += 1;
  result.usage.promptTokens += response.usage.promptTokens;
  result.usage.outputTokens += response.usage.outputTokens;
  result.usage.totalTokens += response.usage.totalTokens;
}
