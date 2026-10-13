import 'server-only';

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { goldenRatings, rubricStatements, rubrics, submissions, type GoldenRating, type Rubric, type RubricStatement, type Submission } from '@/db/schema';
import type { DbOrTx } from '@/db/types';
import { statementHash } from '@/domain/fingerprint';
import { isLiveHumanNote } from '@/domain/golden';
import { goldenGate, type GoldenGate, type Verdict } from '@/domain/gates';
import { describeNamedFiles } from '@/domain/fileLanguage';
import { parseBank, rewriteBank, type BankCandidate } from '@/domain/bank';
import { lintStatement, nearDuplicate, toAffirmativeStatement, type LintResult } from '@/domain/lint';
import { applyInferredScope } from '@/domain/fileScope';
import { correctTag, countFamilies, familyOfStatement, familyOfTag, familyQuotas, quotaSpread, RUBRIC_TAGS, seatsInDisplayOrder } from '@/domain/rubric';
import { holdsRubricSeat, type Actor } from '@/lib/auth/permissions';
import type { FactoryStatement } from '@/lib/engines/rubricFactory';
import { conflict, forbidden, invalid, notFound } from './errors';
import { pruneGoldenRatings, pruneRubricVersions } from './retention';
import { getSubmission, readSource, recordEvent } from './submissions';

function scopeFromCatalog<T extends { statement: string; scope: 'output' | 'inputs'; inputFileIds: string[]; outputFile: string | null }>(row: T, submission: Submission): T {
  const source = readSource(submission);
  return applyInferredScope(row, source?.inputFiles ?? [], source?.goldenFiles ?? []);
}

/**
 * Rubric editing with optimistic concurrency.
 *
 * Every write carries the revision the editor last saw. If the stored
 * revision moved, the save is refused with the current statements so the
 * editor can merge — no silent overwrites between two tabs or two people.
 * A new rubric *version* is created only by the factory or by pasting a
 * full external rubric; edits never destroy golden/stability evidence silently,
 * because ratings are keyed by statement id and a changed statement text
 * invalidates its AI golden rating (see `goldenState`).
 */

export const StatementInput = z.object({
  id: z.string().uuid().optional(),
  tag: z.enum(RUBRIC_TAGS),
  statement: z.string().trim().min(8).max(600),
  notes: z.string().trim().max(600).default(''),
  scope: z.enum(['output', 'inputs']).default('output'),
  inputFileIds: z.array(z.string().min(1)).max(20).default([]),
  outputFile: z.string().trim().min(1).max(300).nullable().default(null),
});
export type StatementInputT = z.infer<typeof StatementInput>;

export const SaveRequest = z.object({
  revision: z.number().int().nonnegative(),
  upserts: z.array(StatementInput).max(200).default([]),
  deletes: z.array(z.string().uuid()).max(200).default([]),
  /** Full ordering after the change; ids absent are appended in existing order. */
  order: z.array(z.string().uuid()).max(200).optional(),
});

export async function currentRubric(database: DbOrTx, submissionId: string): Promise<Rubric | null> {
  return (await database.select().from(rubrics).where(and(eq(rubrics.submissionId, submissionId), eq(rubrics.isCurrent, true))).limit(1))[0] ?? null;
}

export async function ensureCurrentRubric(database: DbOrTx, submissionId: string, actorId: string | null): Promise<Rubric> {
  const existing = await currentRubric(database, submissionId);
  if (existing) return existing;
  const [created] = await database.insert(rubrics).values({ submissionId, version: 1, createdBy: actorId }).returning();
  return created!;
}

export async function statementsOf(database: DbOrTx, rubricId: string): Promise<RubricStatement[]> {
  return database.select().from(rubricStatements).where(eq(rubricStatements.rubricId, rubricId)).orderBy(asc(rubricStatements.position));
}

async function requireRubricSeat(database: DbOrTx, actor: Actor, submissionId: string): Promise<Submission> {
  const submission = await getSubmission(database, submissionId);
  if (!holdsRubricSeat(actor, submission)) throw forbidden('You do not hold the rubric seat on this task.');
  if (submission.stage !== 'rubric') throw conflict(`The rubric is locked while the task is in ${submission.stage}.`);
  return submission;
}

export interface SaveResult {
  revision: number;
  statements: RubricStatement[];
  warnings: { statementId: string; reasons: string[] }[];
}

export async function saveStatements(actor: Actor, submissionId: string, request: z.infer<typeof SaveRequest>): Promise<SaveResult> {
  return db().transaction(async (tx) => {
    const submission = await requireRubricSeat(tx, actor, submissionId);
    const rubric = await ensureCurrentRubric(tx, submissionId, actor.id);
    // Serialise editors on this rubric for the duration of the write.
    const locked = (await tx.select({ revision: rubrics.revision }).from(rubrics).where(eq(rubrics.id, rubric.id)).for('update'))[0]!;
    if (locked.revision !== request.revision) {
      throw conflict('Someone saved a newer version of this rubric. Your view has been refreshed.', { revision: locked.revision, statements: await statementsOf(tx, rubric.id) });
    }

    const existing = await statementsOf(tx, rubric.id);
    const byId = new Map(existing.map((s) => [s.id, s]));
    const now = new Date().toISOString();
    const warnings: SaveResult['warnings'] = [];

    if (request.deletes.length) {
      const unknown = request.deletes.filter((id) => !byId.has(id));
      if (unknown.length) throw invalid('Some statements to delete no longer exist.', { ids: unknown });
      await tx.delete(rubricStatements).where(and(eq(rubricStatements.rubricId, rubric.id), inArray(rubricStatements.id, request.deletes)));
    }

    for (const raw of request.upserts) {
      const input = scopeFromCatalog(raw, submission);
      const tag = correctTag(input.statement, input.tag);
      const lint = lintStatement({ statement: input.statement, tag });
      const family = familyOfTag(tag);
      if (input.id && byId.has(input.id)) {
        const previous = byId.get(input.id)!;
        const textChanged = previous.statement !== input.statement || previous.scope !== input.scope || previous.outputFile !== input.outputFile || JSON.stringify(previous.inputFileIds) !== JSON.stringify(input.inputFileIds);
        await tx
          .update(rubricStatements)
          .set({ tag, family, statement: input.statement, notes: input.notes, scope: input.scope, inputFileIds: input.inputFileIds, outputFile: input.outputFile, lint: lint as unknown as Record<string, unknown>, updatedBy: actor.id, updatedAt: now, ...(previous.origin === 'factory' && textChanged ? { origin: 'manual' as const } : {}) })
          .where(eq(rubricStatements.id, input.id));
        if (lint.overall === 'fail') warnings.push({ statementId: input.id, reasons: lint.reasons });
      } else {
        const position = existing.length + request.upserts.indexOf(raw) + 1;
        const [created] = await tx
          .insert(rubricStatements)
          .values({ id: input.id, rubricId: rubric.id, position, family, tag, statement: input.statement, notes: input.notes, scope: input.scope, inputFileIds: input.inputFileIds, outputFile: input.outputFile, origin: 'manual', lint: lint as unknown as Record<string, unknown>, updatedBy: actor.id, updatedAt: now })
          .returning({ id: rubricStatements.id });
        if (lint.overall === 'fail') warnings.push({ statementId: created!.id, reasons: lint.reasons });
      }
    }

    const after = await statementsOf(tx, rubric.id);
    const order = request.order ? [...request.order.filter((id) => after.some((s) => s.id === id)), ...after.map((s) => s.id).filter((id) => !request.order!.includes(id))] : after.map((s) => s.id);
    // Two-phase renumber avoids transient unique collisions on (rubric_id, position).
    await tx.update(rubricStatements).set({ position: sql`${rubricStatements.position} + 100000` }).where(eq(rubricStatements.rubricId, rubric.id));
    for (const [index, id] of order.entries()) await tx.update(rubricStatements).set({ position: index + 1 }).where(eq(rubricStatements.id, id));

    const [bumped] = await tx.update(rubrics).set({ revision: sql`${rubrics.revision} + 1` }).where(eq(rubrics.id, rubric.id)).returning({ revision: rubrics.revision });
    await tx.update(submissions).set({ revision: sql`${submissions.revision} + 1` }).where(eq(submissions.id, submissionId));
    return { revision: bumped!.revision, statements: await statementsOf(tx, rubric.id), warnings };
  });
}

/** Replaces the current rubric with a new version holding the factory's statements. */
export async function installFactoryVersion(database: DbOrTx, submissionId: string, actorId: string | null, input: { seeds: string[]; statements: FactoryStatement[]; generation: Record<string, unknown> }): Promise<Rubric> {
  const previous = await currentRubric(database, submissionId);
  if (previous) await database.update(rubrics).set({ isCurrent: false }).where(eq(rubrics.id, previous.id));
  const [rubric] = await database
    .insert(rubrics)
    .values({ submissionId, version: (previous?.version ?? 0) + 1, seeds: input.seeds, generation: input.generation, createdBy: actorId })
    .returning();
  if (input.statements.length) {
    await database.insert(rubricStatements).values(
      seatsInDisplayOrder(input.statements.map((s, index) => ({ ...s, id: s.claimKey || String(index), position: index }))).map((s, index) => ({
        rubricId: rubric!.id,
        position: index + 1,
        family: familyOfStatement(s.statement, s.tag),
        tag: correctTag(s.statement, s.tag),
        statement: s.statement,
        notes: s.notes,
        claimKey: s.claimKey,
        origin: 'factory' as const,
        lint: s.lint as unknown as Record<string, unknown>,
        scope: s.scope ?? 'output',
        inputFileIds: s.inputFileIds ?? [],
        outputFile: s.outputFile ?? null,
        updatedBy: actorId,
      })),
    );
  }
  await database.update(submissions).set({ revision: sql`${submissions.revision} + 1` }).where(eq(submissions.id, submissionId));
  await pruneRubricVersions(database, submissionId);
  await recordEvent(database, submissionId, actorId, 'rubric_generated', { version: rubric!.version, statements: input.statements.length });
  return rubric!;
}

/* ─────────────────────────────────────────────── golden ── */

export interface GoldenAuditEntry {
  ai?: { verdict: boolean | null; evidence: string; model: string | null };
  human?: { verdict: boolean | null; evidence: string };
}

export interface GoldenState {
  /** Effective verdict per statement: newest human override, else newest valid AI rating. */
  verdicts: Record<string, Verdict>;
  evidence: Record<string, string>;
  errors: Record<string, string>;
  sources: Record<string, 'ai' | 'human' | 'stale'>;
  /** Latest AI and human rows, both kept. Effective grade is human when present and newer. */
  audit: Record<string, GoldenAuditEntry>;
  gate: GoldenGate;
  ratings: GoldenRating[];
}

/**
 * The AI rating counts only while the statement reads exactly as it did
 * when graded (`basis.statementHash`); edits make it stale. A human row
 * outranks AI only when it has a real observation — import stubs do not.
 * A later failed/cancelled autorate does not hide an earlier Yes/No.
 */
export async function goldenState(database: DbOrTx, rubricId: string, statements: RubricStatement[]): Promise<GoldenState> {
  const ratings = await database.select().from(goldenRatings).where(eq(goldenRatings.rubricId, rubricId)).orderBy(desc(goldenRatings.createdAt));
  const verdicts: Record<string, Verdict> = {};
  const evidence: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const sources: GoldenState['sources'] = {};
  const audit: Record<string, GoldenAuditEntry> = {};
  for (const statement of statements) {
    verdicts[statement.id] = null;
    const hash = statementHash(statement);
    const own = ratings.filter((r) => r.statementId === statement.id);
    const human = own.find((r) => r.source === 'human');
    const usableAi = own.find((r) => {
      if (r.source !== 'ai' || r.error) return false;
      if ((r.basis as { statementHash?: string }).statementHash !== hash) return false;
      return r.verdict === true || r.verdict === false;
    });
    const failedAi = own.find((r) => r.source === 'ai' && Boolean(r.error));
    const staleAi = own.find((r) => r.source === 'ai' && !r.error && (r.basis as { statementHash?: string }).statementHash !== hash);
    const humanNote = (human?.evidence || human?.reason || '').trim();
    const liveHuman = Boolean(human && isLiveHumanNote(humanNote));
    audit[statement.id] = {
      ...(usableAi ? { ai: { verdict: usableAi.verdict, evidence: usableAi.evidence, model: usableAi.model ?? null } } : {}),
      ...(liveHuman ? { human: { verdict: human!.verdict, evidence: humanNote } } : {}),
    };
    if (liveHuman && human && (!usableAi || human.createdAt >= usableAi.createdAt)) {
      verdicts[statement.id] = human.verdict;
      evidence[statement.id] = humanNote;
      sources[statement.id] = 'human';
      continue;
    }
    if (usableAi) {
      verdicts[statement.id] = usableAi.verdict;
      evidence[statement.id] = usableAi.evidence;
      sources[statement.id] = 'ai';
      continue;
    }
    if (failedAi?.error) {
      errors[statement.id] = failedAi.error;
      sources[statement.id] = 'ai';
      continue;
    }
    if (staleAi) sources[statement.id] = 'stale';
  }
  const gate = goldenGate({ answers: verdicts, errors, statementIds: statements.map((s) => s.id) });
  return { verdicts, evidence, errors, sources, audit, gate, ratings };
}

/** Appends a human rating. The AI row stays; the newest human is the effective grade. */
export async function overrideGolden(actor: Actor, submissionId: string, statementId: string, verdict: boolean, evidence: string): Promise<void> {
  const note = evidence.trim();
  if (note.length < 5) throw invalid('An observation of at least 5 characters is required for a human override.');
  await db().transaction(async (tx) => {
    await requireRubricSeat(tx, actor, submissionId);
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw notFound('The rubric');
    const statement = (await tx.select().from(rubricStatements).where(and(eq(rubricStatements.id, statementId), eq(rubricStatements.rubricId, rubric.id))).limit(1))[0];
    if (!statement) throw notFound('The statement');
    await tx.insert(goldenRatings).values({
      rubricId: rubric.id,
      statementId,
      source: 'human',
      verdict,
      evidence: note,
      reason: note,
      basis: { statementText: statement.statement, rubricRevision: rubric.revision },
      createdBy: actor.id,
    });
    await pruneGoldenRatings(tx, rubric.id);
    await recordEvent(tx, submissionId, actor.id, 'golden_overridden', { statementId, verdict });
  });
}

/* ──────────────────────────────────────── AI lint persistence ── */

/** Stores LLM lint verdicts for statements whose wording still matches. */
export async function persistLint(actor: Actor, submissionId: string, results: Record<string, { lint: LintResult; statement: string }>): Promise<number> {
  return db().transaction(async (tx) => {
    await requireRubricSeat(tx, actor, submissionId);
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw notFound('The rubric');
    const rows = await statementsOf(tx, rubric.id);
    let written = 0;
    for (const row of rows) {
      const entry = results[row.id];
      if (!entry || entry.statement !== row.statement) continue;
      await tx.update(rubricStatements).set({ lint: entry.lint as unknown as Record<string, unknown> }).where(eq(rubricStatements.id, row.id));
      written += 1;
    }
    return written;
  });
}

/* ─────────────────────────────────────────── bank replacement ── */

export type { BankCandidate } from '@/domain/bank';

function unusedCandidate(rubric: Rubric, rows: RubricStatement[], claimKey: string): BankCandidate {
  const seatedKeys = new Set(rows.map((s) => s.claimKey).filter(Boolean));
  const candidate = parseBank(rubric.generation).find((c) => c.claimKey === claimKey);
  if (!candidate) throw conflict('That claim is not in the unused bank; pick another.');
  if (seatedKeys.has(candidate.claimKey)) throw conflict('That claim is already seated.');
  return candidate;
}

function displacedOf(statement: RubricStatement): BankCandidate | null {
  if (!statement.claimKey) return null;
  return {
    claimKey: statement.claimKey,
    statement: statement.statement,
    tag: statement.tag,
    family: statement.family,
    notes: statement.notes,
    seedId: '',
  };
}

/**
 * Unused candidates from the generation bank for a seat: same family, claim
 * key not already seated, wording not a paraphrase of any seated statement.
 */
export async function replacementCandidates(database: DbOrTx, submissionId: string, statementId: string, limit = 8): Promise<{ statement: RubricStatement; candidates: BankCandidate[] }> {
  const rubric = await currentRubric(database, submissionId);
  if (!rubric) throw notFound('The rubric');
  const rows = await statementsOf(database, rubric.id);
  const statement = rows.find((s) => s.id === statementId);
  if (!statement) throw notFound('The statement');
  const seatedKeys = new Set(rows.map((s) => s.claimKey).filter(Boolean));
  const candidates = parseBank(rubric.generation)
    .filter((c) => familyOfStatement(c.statement, c.tag) === familyOfStatement(statement.statement, statement.tag) && !seatedKeys.has(c.claimKey))
    .filter((c) => lintStatement({ statement: c.statement, tag: c.tag }).overall === 'pass')
    .filter((c) => !rows.some((s) => nearDuplicate(s.statement, c.statement)))
    .sort((a, b) => (b.strength ?? 50) - (a.strength ?? 50))
    .slice(0, limit);
  return { statement, candidates };
}

/** Swaps a seat's wording for any unused bank candidate; the seat id survives. */
export async function keepReplacement(actor: Actor, submissionId: string, input: { statementId: string; claimKey: string; revision: number }): Promise<SaveResult> {
  return db().transaction(async (tx) => {
    const submission = await requireRubricSeat(tx, actor, submissionId);
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw notFound('The rubric');
    const locked = (await tx.select({ revision: rubrics.revision }).from(rubrics).where(eq(rubrics.id, rubric.id)).for('update'))[0]!;
    if (locked.revision !== input.revision) throw conflict('Someone saved a newer version of this rubric. Your view has been refreshed.', { revision: locked.revision, statements: await statementsOf(tx, rubric.id) });
    const rows = await statementsOf(tx, rubric.id);
    const statement = rows.find((s) => s.id === input.statementId);
    if (!statement) throw notFound('The statement');
    const candidate = unusedCandidate(rubric, rows, input.claimKey);
    const tag = correctTag(candidate.statement, candidate.tag);
    const lint = lintStatement({ statement: candidate.statement, tag });
    const scoped = scopeFromCatalog({ statement: candidate.statement, scope: 'output' as const, inputFileIds: [], outputFile: null }, submission);
    await tx
      .update(rubricStatements)
      .set({ statement: candidate.statement, tag, family: familyOfTag(tag), notes: candidate.notes, claimKey: candidate.claimKey, origin: 'bank', lint: lint as unknown as Record<string, unknown>, scope: scoped.scope, inputFileIds: scoped.inputFileIds, outputFile: scoped.outputFile, updatedBy: actor.id, updatedAt: new Date().toISOString() })
      .where(eq(rubricStatements.id, statement.id));
    const [bumped] = await tx
      .update(rubrics)
      .set({ revision: sql`${rubrics.revision} + 1`, generation: rewriteBank(rubric.generation, candidate, displacedOf(statement)) })
      .where(eq(rubrics.id, rubric.id))
      .returning({ revision: rubrics.revision });
    await tx.update(submissions).set({ revision: sql`${submissions.revision} + 1` }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, 'statement_replaced', { statementId: statement.id, from: statement.claimKey, to: candidate.claimKey });
    return { revision: bumped!.revision, statements: await statementsOf(tx, rubric.id), warnings: [] };
  });
}

/** Seats an unused bank claim as a new row (does not replace an existing seat). */
export async function addFromBank(actor: Actor, submissionId: string, input: { claimKey: string; revision: number }): Promise<SaveResult> {
  return db().transaction(async (tx) => {
    const submission = await requireRubricSeat(tx, actor, submissionId);
    const rubric = await currentRubric(tx, submissionId);
    if (!rubric) throw notFound('The rubric');
    const locked = (await tx.select({ revision: rubrics.revision }).from(rubrics).where(eq(rubrics.id, rubric.id)).for('update'))[0]!;
    if (locked.revision !== input.revision) throw conflict('Someone saved a newer version of this rubric. Your view has been refreshed.', { revision: locked.revision, statements: await statementsOf(tx, rubric.id) });
    const rows = await statementsOf(tx, rubric.id);
    const candidate = unusedCandidate(rubric, rows, input.claimKey);
    const tag = correctTag(candidate.statement, candidate.tag);
    const family = familyOfTag(tag);
    const spread = quotaSpread(countFamilies(rows));
    if (!spread.canAdd[family]) {
      throw conflict(`Delete a ${family === 'format' ? 'Format' : family === 'content' ? 'Content' : 'Visual'} seat before adding another. ${spread.warning}`.trim());
    }
    const lint = lintStatement({ statement: candidate.statement, tag });
    const scoped = scopeFromCatalog({ statement: candidate.statement, scope: 'output' as const, inputFileIds: [], outputFile: null }, submission);
    await tx.insert(rubricStatements).values({
      rubricId: rubric.id,
      position: rows.length + 1,
      family: familyOfTag(tag),
      tag,
      statement: candidate.statement,
      notes: candidate.notes,
      claimKey: candidate.claimKey,
      origin: 'bank',
      lint: lint as unknown as Record<string, unknown>,
      scope: scoped.scope,
      inputFileIds: scoped.inputFileIds,
      outputFile: scoped.outputFile,
      updatedBy: actor.id,
      updatedAt: new Date().toISOString(),
    });
    const [bumped] = await tx
      .update(rubrics)
      .set({ revision: sql`${rubrics.revision} + 1`, generation: rewriteBank(rubric.generation, candidate) })
      .where(eq(rubrics.id, rubric.id))
      .returning({ revision: rubrics.revision });
    await tx.update(submissions).set({ revision: sql`${submissions.revision} + 1` }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, submissionId, actor.id, 'statement_added_from_bank', { claimKey: candidate.claimKey });
    return { revision: bumped!.revision, statements: await statementsOf(tx, rubric.id), warnings: lint.overall === 'fail' ? [{ statementId: '', reasons: lint.reasons }] : [] };
  });
}

/* ────────────────────────────────────────────────── import ── */

export async function replaceRubricFromPaste(
  actor: Actor,
  submissionId: string,
  input: { revision: number; rows: { tag: (typeof RUBRIC_TAGS)[number]; statement: string }[] },
): Promise<SaveResult & { imported: number }> {
  if (input.rows.length === 0) throw invalid('Paste at least one statement.');
  if (input.rows.length > 200) throw invalid('Import at most 200 statements at a time.');
  const prepared = input.rows.map((row) => {
    const statement = describeNamedFiles(toAffirmativeStatement(row.statement));
    const tag = correctTag(statement, row.tag);
    return { statement, tag, family: familyOfTag(tag) };
  });
  if (prepared.some((row) => row.statement.length < 8 || row.statement.length > 600)) {
    throw invalid('Every statement must be between 8 and 600 characters.');
  }
  const spread = quotaSpread(countFamilies(prepared), familyQuotas());
  if (!spread.ready) throw invalid(`Seat the rubric at 5 Format, 15 Content, 30 Visual first. ${spread.warning}`);

  const result = await db().transaction(async (tx) => {
    const submission = await requireRubricSeat(tx, actor, submissionId);
    const previous = await currentRubric(tx, submissionId);
    if (previous) {
      const locked = (await tx.select({ revision: rubrics.revision }).from(rubrics).where(eq(rubrics.id, previous.id)).for('update'))[0]!;
      if (locked.revision !== input.revision) {
        throw conflict('Someone saved a newer version of this rubric. Your view has been refreshed.', { revision: locked.revision, statements: await statementsOf(tx, previous.id) });
      }
      await tx.update(rubrics).set({ isCurrent: false }).where(eq(rubrics.id, previous.id));
    } else if (input.revision !== 0) {
      throw conflict('Someone saved a newer version of this rubric. Your view has been refreshed.');
    }

    const [rubric] = await tx
      .insert(rubrics)
      .values({ submissionId, version: (previous?.version ?? 0) + 1, seeds: [], generation: {}, createdBy: actor.id })
      .returning();
    const now = new Date().toISOString();
    const warnings: SaveResult['warnings'] = [];
    await tx.insert(rubricStatements).values(
      seatsInDisplayOrder(prepared.map((row, index) => ({ ...row, id: String(index), position: index }))).map((row, index) => {
        const lint = lintStatement({ statement: row.statement, tag: row.tag });
        const scoped = scopeFromCatalog({ statement: row.statement, scope: 'output' as const, inputFileIds: [], outputFile: null }, submission);
        if (lint.overall === 'fail') warnings.push({ statementId: '', reasons: lint.reasons });
        return {
          rubricId: rubric!.id,
          position: index + 1,
          family: row.family,
          tag: row.tag,
          statement: row.statement,
          notes: '',
          scope: scoped.scope,
          inputFileIds: scoped.inputFileIds,
          outputFile: scoped.outputFile,
          origin: 'import' as const,
          lint: lint as unknown as Record<string, unknown>,
          updatedBy: actor.id,
          updatedAt: now,
        };
      }),
    );
    await tx.update(submissions).set({ revision: sql`${submissions.revision} + 1` }).where(eq(submissions.id, submissionId));
    await pruneRubricVersions(tx, submissionId);
    await recordEvent(tx, submissionId, actor.id, 'rubric_replaced_from_paste', { version: rubric!.version, statements: prepared.length });
    const statements = await statementsOf(tx, rubric!.id);
    return { revision: rubric!.revision, statements, warnings, imported: statements.length };
  });
  return result;
}

export function toGradeStatement(s: RubricStatement, seat?: number) {
  return { id: s.id, seat, statement: s.statement, tag: correctTag(s.statement, s.tag), scope: s.scope, inputFileIds: s.inputFileIds, outputFile: s.outputFile };
}
