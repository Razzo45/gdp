import './railway-target';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  aiOutputFiles,
  calibrations,
  goldenRatings,
  profiles,
  reviewFeedback,
  rubricStatements,
  rubrics,
  stabilityAcceptances,
  stabilityPasses,
  submissions,
  watchedProjects,
} from '@/db/schema';
import { sha256, sourceFingerprint, statementHash } from '@/domain/fingerprint';
import { isLiveHumanNote } from '@/domain/golden';
import { factoryStatementsFromLegacy, latestLegacyRun, mapLegacySeatIds, normalizeClaim, remapEvidence, remapVerdicts, seedsFromLegacy } from '@/domain/legacyImport';
import { installFactoryVersion } from '@/lib/services/rubric';
import { pruneCalibrations, pruneGoldenRatings, pruneReviewFeedback, pruneStabilityGroups } from '@/lib/services/retention';
import { putObject } from '@/lib/storage';

/**
 * Copies Golden, human AI eval, stability, and AI output files from the
 * read-only snapshot (+ Supabase Storage reads) into app.* on DATABASE_URL.
 * Never writes to live Supabase.
 *
 *   npm run db:import-eval
 *   npm run db:import-eval -- --apply
 */

const SNAP = path.join(process.cwd(), 'tmp', 'supabase-snapshot');
const AI_BUCKET = 'submissions';

function arg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function load<T = Record<string, unknown>>(name: string): T[] {
  const file = path.join(SNAP, name);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isSupabaseHost(url: string): boolean {
  return /supabase\.(co|com)|loop\.supabase|pooler\.supabase/i.test(url);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function latest<T>(rows: T[], at: (row: T) => string, keep = 2): T[] {
  return [...rows].sort((a, b) => at(b).localeCompare(at(a))).slice(0, keep);
}

function asGroupId(raw: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  const hex = sha256(raw).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface AiRef {
  id: string;
  name: string;
  mime: string;
  path: string;
}

function aiRefsFrom(...values: unknown[]): AiRef[] {
  const out: AiRef[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.path === 'string' && value.path.startsWith('wirestock-ai/')) {
      const id = str(value, 'id') || value.path;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        name: str(value, 'name', 'originalFileName') || path.posix.basename(value.path),
        mime: str(value, 'mime', 'mimeType') || 'application/octet-stream',
        path: value.path,
      });
    }
    for (const inner of Object.values(value)) if (inner && typeof inner === 'object') walk(inner);
  };
  for (const value of values) walk(value);
  return out;
}

async function downloadAi(storagePath: string): Promise<Uint8Array | null> {
  const url = (process.env['SUPABASE_READ_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'])?.trim();
  const key = (process.env['SUPABASE_READ_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'])?.trim();
  if (!url || !key) return null;
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.storage.from(AI_BUCKET).download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function main() {
  const apply = arg('--apply');
  const stabilityOnly = arg('--stability-only');
  const fillMissing = arg('--fill-missing');
  const target = process.env['DATABASE_URL']?.trim() ?? '';
  if (!target) throw new Error('DATABASE_URL is not set.');
  if (isSupabaseHost(target)) throw new Error('Refusing: DATABASE_URL is a Supabase host.');
  if (!existsSync(path.join(SNAP, 'index.json'))) throw new Error(`No snapshot at ${SNAP}.`);

  const legacySubs = load('public.wirestock_submissions.json');
  const internalOf = new Map(legacySubs.filter(isRecord).map((row) => [str(row, 'submission_id'), str(row, 'id')]));
  const runs = load('public.wirestock_rubric_runs.json').filter(isRecord);
  const runsByInternal = new Map<string, Record<string, unknown>[]>();
  for (const run of runs) {
    const id = str(run, 'submission_id');
    const list = runsByInternal.get(id) ?? [];
    list.push(run);
    runsByInternal.set(id, list);
  }

  const quality = load('public.wirestock_quality_results.json').filter(isRecord);
  const answers = load('public.wirestock_rubric_answers.json').filter(isRecord);
  const cals = load('public.wirestock_calibrations.json').filter(isRecord);
  const stability = load('public.local_stability_results.json').filter(isRecord);
  const reviews = [...load('public.wirestock_reviews_v1.json'), ...load('public.wirestock_submission_reviews.json')].filter(isRecord);
  const feedback = load('public.wirestock_review_feedback.json').filter(isRecord);

  const database = db();
  const knownUsers = new Set((await database.select({ id: profiles.id }).from(profiles)).map((row) => row.id));
  const knownUser = (id: string | null) => (id && knownUsers.has(id) ? id : null);
  const neonSubs = await database.select().from(submissions);
  const currentRubrics = await database.select().from(rubrics).where(eq(rubrics.isCurrent, true));
  const allStatements = await database.select().from(rubricStatements);
  const statementsByRubric = new Map<string, typeof allStatements>();
  for (const row of allStatements) {
    const list = statementsByRubric.get(row.rubricId) ?? [];
    list.push(row);
    statementsByRubric.set(row.rubricId, list);
  }

  let goldenJobs = 0;
  let humanRows = 0;
  let calRows = 0;
  let stabGroups = 0;
  let files = 0;
  let fileBytes = 0;
  let matchedSeats = 0;
  let reviewsWritten = 0;

  const plan = neonSubs.map((sub) => {
    const internal = internalOf.get(sub.catalogSubmissionId);
    const rubric = currentRubrics.find((row) => row.submissionId === sub.id);
    const statements = rubric ? (statementsByRubric.get(rubric.id) ?? []) : [];
    const run = internal ? latestLegacyRun(runsByInternal.get(internal) ?? []) : null;
    const seats = run ? mapLegacySeatIds((run['rows'] as { id?: unknown; statement?: unknown }[]) ?? [], statements) : new Map<string, string>();
    return { sub, internal, rubric, statements, run, seats };
  });

  for (const row of plan) matchedSeats += row.seats.size;
  const missingRubric = plan.filter((item) => !item.rubric && item.run && factoryStatementsFromLegacy(item.run['rows']).length);
  console.log(`Target (${apply ? 'APPLY' : 'dry-run'}): ${neonSubs.length} tasks, ${plan.filter((p) => p.rubric).length} with a rubric, ${matchedSeats} seats remapped, ${missingRubric.length} missing rubrics that have a live run.`);
  console.log(`Sources: quality=${quality.length} rubric_answers=${answers.length} calibrations=${cals.length} stability=${stability.length} reviews=${reviews.length}`);

  if (!apply) {
    console.log('Re-run with --apply [--fill-missing] to write Golden, human AI eval, stability, and AI files.');
    process.exit(0);
  }

  if (stabilityOnly) {
    console.log('Stability-only pass: existing Golden / calibration rows are left alone.');
  }
  if (fillMissing) {
    console.log('Fill-missing: keep Railway Golden/calibration/stability that already exist on the current rubric.');
  }

  for (const item of plan) {
    if (item.rubric || !item.run) continue;
    const factory = factoryStatementsFromLegacy(item.run['rows']);
    if (!factory.length) continue;
    const rubric = await installFactoryVersion(database, item.sub.id, knownUser(str(item.run, 'created_by') || null), {
      seeds: seedsFromLegacy(item.run),
      statements: factory,
      generation: { provenance: 'import-eval-restore', catalogId: item.sub.catalogSubmissionId },
    });
    const statements = await database.select().from(rubricStatements).where(eq(rubricStatements.rubricId, rubric.id));
    item.rubric = rubric;
    item.statements = statements;
    item.seats = mapLegacySeatIds((item.run['rows'] as { id?: unknown; statement?: unknown }[]) ?? [], statements);
  }

  for (const item of plan) {
    if (stabilityOnly || !item.internal || !item.rubric || item.statements.length === 0 || item.seats.size === 0) continue;
    const { sub, internal, rubric, statements, seats } = item;

    const qFor = latest(
      quality.filter((row) => str(row, 'submission_id') === internal && row['complete'] === true),
      (row) => str(row, 'created_at'),
    );
    const runIds = new Set((runsByInternal.get(internal) ?? []).map((row) => str(row, 'id')));
    const answerRows = latest(
      answers.filter((row) => runIds.has(str(row, 'run_id'))),
      (row) => str(row, 'updated_at', 'calibrated_at'),
    );
    const calFor = latest(
      cals.filter((row) => str(row, 'submission_id') === internal),
      (row) => str(row, 'created_at'),
    );
    const stabFor = latest(
      stability.filter((row) => str(row, 'submission_id') === internal),
      (row) => str(row, 'created_at'),
    );
    const keepGolden = fillMissing && (await database.select({ id: goldenRatings.id }).from(goldenRatings).where(eq(goldenRatings.rubricId, rubric.id)).limit(1))[0];
    const keepCal = fillMissing && (await database.select({ id: calibrations.id }).from(calibrations).where(eq(calibrations.rubricId, rubric.id)).limit(1))[0];
    const keepStab = fillMissing && (await database.select({ id: stabilityPasses.id }).from(stabilityPasses).where(eq(stabilityPasses.rubricId, rubric.id)).limit(1))[0];
    const keepReview = fillMissing && (await database.select({ id: reviewFeedback.id }).from(reviewFeedback).where(eq(reviewFeedback.submissionId, sub.id)).limit(1))[0];
    const refs = keepGolden && keepCal && keepStab ? [] : aiRefsFrom(qFor, answerRows, calFor, stabFor);
    if (!keepGolden) await database.delete(goldenRatings).where(eq(goldenRatings.rubricId, rubric.id));
    if (!keepCal) await database.delete(calibrations).where(eq(calibrations.rubricId, rubric.id));
    if (!keepStab) {
      await database.delete(stabilityAcceptances).where(eq(stabilityAcceptances.rubricId, rubric.id));
      await database.delete(stabilityPasses).where(eq(stabilityPasses.rubricId, rubric.id));
    }
    if (!keepReview) await database.delete(reviewFeedback).where(eq(reviewFeedback.submissionId, sub.id));

    const fileIds: string[] = [];
    const fileShas: string[] = [];
    for (const ref of refs.slice(0, 12)) {
      const storagePath = `ai-outputs/${sub.id}/legacy/${ref.id}-${ref.name.replace(/[\\/]/g, '_')}`;
      const existing = (await database.select().from(aiOutputFiles).where(eq(aiOutputFiles.storagePath, storagePath)).limit(1))[0];
      if (existing && !existing.removedAt) {
        fileIds.push(existing.id);
        fileShas.push(existing.sha256);
        continue;
      }
      const bytes = await downloadAi(ref.path);
      if (!bytes) {
        console.warn(`Could not download ${ref.path}`);
        continue;
      }
      const digest = sha256(bytes);
      await putObject(storagePath, bytes, ref.mime);
      const [saved] = await database
        .insert(aiOutputFiles)
        .values({ submissionId: sub.id, name: ref.name, mime: ref.mime, size: bytes.byteLength, sha256: digest, storagePath })
        .onConflictDoNothing()
        .returning();
      const row = saved ?? (await database.select().from(aiOutputFiles).where(eq(aiOutputFiles.storagePath, storagePath)).limit(1))[0];
      if (!row) continue;
      fileIds.push(row.id);
      fileShas.push(row.sha256);
      files += 1;
      fileBytes += bytes.byteLength;
    }

    const basisFiles = { aiOutputIds: fileIds, aiOutputShas: fileShas, provenance: 'legacy-snapshot' };

    if (!keepGolden && qFor.length) {
      for (const result of qFor) {
        const grades = record(result['grades']);
        const verdicts = remapVerdicts(record(grades['answers']), seats);
        const evidence = remapEvidence(record(grades['evidence']), seats);
        const jobId = str(result, 'id') || crypto.randomUUID();
        const rows = statements
          .filter((statement) => statement.id in verdicts)
          .map((statement) => ({
            rubricId: rubric.id,
            statementId: statement.id,
            jobId,
            source: 'ai' as const,
            verdict: verdicts[statement.id]!,
            evidence: evidence[statement.id] ?? '',
            model: 'legacy-quality',
            basis: { statementHash: statementHash(statement), rubricRevision: rubric.revision, ...basisFiles, qualityResultId: str(result, 'id') },
          }));
        if (rows.length) {
          await database.insert(goldenRatings).values(rows);
          goldenJobs += 1;
        }
      }
    } else if (!keepGolden) {
      for (const row of answerRows) {
        const sources = record(row['sources']);
        const verdicts = remapVerdicts(record(row['answers']), seats);
        const evidence = remapEvidence(record(row['evidence']), seats);
        const jobId = crypto.randomUUID();
        const aiRows = statements
          .filter((statement) => {
            const legacy = [...seats.entries()].find(([, id]) => id === statement.id)?.[0];
            return statement.id in verdicts && (!legacy || /autorate|ai|golden/i.test(String(sources[legacy] ?? 'autorate_golden')));
          })
          .map((statement) => ({
            rubricId: rubric.id,
            statementId: statement.id,
            jobId,
            source: 'ai' as const,
            verdict: verdicts[statement.id]!,
            evidence: evidence[statement.id] ?? '',
            model: 'legacy-autorate',
            basis: { statementHash: statementHash(statement), rubricRevision: rubric.revision, ...basisFiles },
          }));
        if (aiRows.length) {
          await database.insert(goldenRatings).values(aiRows);
          goldenJobs += 1;
        }
      }
    }

    for (const row of keepGolden ? [] : answerRows) {
      const sources = record(row['sources']);
      const verdicts = remapVerdicts(record(row['answers']), seats);
      const evidence = remapEvidence(record(row['evidence']), seats);
      const humans = statements.filter((statement) => {
        const legacy = [...seats.entries()].find(([, id]) => id === statement.id)?.[0];
        const note = (evidence[statement.id] ?? '').trim();
        return legacy && String(sources[legacy] ?? '') === 'human' && statement.id in verdicts && isLiveHumanNote(note);
      });
      if (!humans.length) continue;
      await database.insert(goldenRatings).values(
        humans.map((statement) => ({
          rubricId: rubric.id,
          statementId: statement.id,
          source: 'human' as const,
          verdict: verdicts[statement.id]!,
          evidence: evidence[statement.id]!,
          reason: evidence[statement.id]!,
          basis: { statementText: statement.statement, rubricRevision: rubric.revision, provenance: 'legacy-snapshot' },
        })),
      );
      humanRows += humans.length;
    }

    const calSources = calFor.length
      ? calFor.map((row) => ({
          answers: record(record(row['saved'])['answers']),
          evidence: record(record(row['saved'])['evidence']),
          score: Number(row['score_percent'] ?? 0),
          submitted: true,
          reviewerId: str(row, 'created_by') || null,
          at: str(row, 'created_at'),
        }))
      : answerRows
          .filter((row) => Object.keys(record(row['calibration_answers'])).length)
          .map((row) => ({
            answers: record(row['calibration_answers']),
            evidence: record(row['calibration_evidence']),
            score: 0,
            submitted: Boolean(row['calibrated_at']),
            reviewerId: str(row, 'calibrated_by') || null,
            at: str(row, 'calibrated_at', 'updated_at'),
          }));

    for (const cal of keepCal ? [] : calSources) {
      const mapped = remapVerdicts(cal.answers, seats);
      if (!Object.keys(mapped).length) continue;
      const evidence = remapEvidence(cal.evidence, seats);
      const scored = cal.score || (100 * Object.values(mapped).filter(Boolean).length) / Math.max(statements.length, 1);
      await database.insert(calibrations).values({
        rubricId: rubric.id,
          reviewerId: knownUser(cal.reviewerId),
        answers: mapped,
        evidence,
        scorePercent: Number(scored.toFixed(2)),
        submitted: cal.submitted,
        basis: { rubricRevision: rubric.revision, statementIds: statements.map((s) => s.id), ...basisFiles },
      });
      calRows += 1;
    }

    for (const group of keepStab ? [] : stabFor) {
      const groupId = str(group, 'group_id') || crypto.randomUUID();
      const passes = Array.isArray(group['runs']) ? (group['runs'] as Record<string, unknown>[]) : [];
      for (const pass of passes) {
        const ordinal = Number(pass['ordinal'] ?? pass['passIndex'] ?? 0) || 1;
        const mapped = remapVerdicts(Object.keys(record(pass['answers'])).length ? record(pass['answers']) : record(pass['grades']), seats);
        const evidence = remapEvidence(Object.keys(record(pass['evidence'])).length ? record(pass['evidence']) : record(pass['grades']), seats);
        if (!Object.keys(mapped).length) continue;
        await database.insert(stabilityPasses).values({
          rubricId: rubric.id,
          groupId,
          passIndex: ordinal,
          answers: mapped,
          evidence,
          errors: {},
          scorePercent: typeof pass['scorePercent'] === 'number' ? pass['scorePercent'] : null,
          model: typeof pass['model'] === 'string' ? pass['model'] : null,
          basis: { rubricRevision: rubric.revision, ...basisFiles, legacyGroupId: groupId },
        });
      }
      stabGroups += 1;
      if (group['accepted_at']) {
        const evals = record(group['evaluation']);
        const scores = Array.isArray(evals['scores']) ? (evals['scores'] as number[]).filter((n) => typeof n === 'number') : [];
        await database.insert(stabilityAcceptances).values({
          rubricId: rubric.id,
          groupId,
          acceptedBy: knownUser(str(group, 'accepted_by') || null),
          scores,
          spread: typeof evals['spread'] === 'number' ? evals['spread'] : 0,
          basis: { ...basisFiles, provenance: 'legacy-snapshot' },
        });
      }
    }

    const review = reviews.find((row) => str(row, 'submission_id') === internal);
    const note = feedback.find((row) => str(row, 'submission_id') === internal);
    const status = str(review ?? note ?? {}, 'status');
    if (!keepReview && (review || note) && (status === 'approved' || status === 'changes_requested')) {
      await database.insert(reviewFeedback).values({
        submissionId: sub.id,
        rubricId: rubric.id,
        reviewerId: knownUser(str(review ?? note ?? {}, 'decision_by', 'reviewer_assignee_id', 'created_by') || null),
        decision: status,
        feedback: str(note ?? review ?? {}, 'note', 'reason') || '',
      });
      reviewsWritten += 1;
    }
    if (sub.stage === 'review' || sub.reviewStatus === 'pending' || sub.reviewStatus === 'approved' || sub.reviewStatus === 'changes_requested') {
      await database.update(submissions).set({ reviewRubricId: rubric.id }).where(eq(submissions.id, sub.id));
    }

    await pruneGoldenRatings(database, rubric.id);
    await pruneCalibrations(database, rubric.id);
    await pruneStabilityGroups(database, rubric.id);
    await pruneReviewFeedback(database, sub.id);
  }

  const jobs = load('public.local_stability_jobs.json').filter(isRecord);
  const watches = await database.select().from(watchedProjects);
  const fallbackProject = watches[0]?.projectId ?? '';
  let reconstructed = 0;

  const rowsFromRecord = (value: unknown): { id: string; statement: string }[] =>
    Object.entries(record(value))
      .map(([id, raw]) => ({
        id,
        statement: isRecord(raw) ? str(raw, 'statement', 'text') : String(raw ?? ''),
      }))
      .filter((row) => row.id && row.statement);

  const legacyStatementsOf = (group: Record<string, unknown>): { id: string; statement: string }[] => {
    const job =
      jobs.find((row) => str(row, 'submission_id') === str(group, 'submission_id') && str(row, 'id') === str(group, 'job_id', 'group_id')) ??
      jobs.find((row) => str(row, 'submission_id') === str(group, 'submission_id'));
    const seats = Array.isArray(record(job?.['input'])['seats']) ? (record(job?.['input'])['seats'] as Record<string, unknown>[]) : [];
    if (seats.length) {
      return seats.map((seat) => ({ id: str(seat, 'id'), statement: str(seat, 'statement') })).filter((row) => row.id && row.statement);
    }
    const top = rowsFromRecord(group['statements']);
    if (top.length) return top;
    const passes = Array.isArray(group['runs']) ? (group['runs'] as Record<string, unknown>[]) : [];
    for (const pass of passes) {
      const fromPass = rowsFromRecord(pass['statements']);
      if (fromPass.length) return fromPass;
      const fromGrades = Object.entries(record(pass['grades'])).map(([id, raw]) => ({
        id,
        statement: isRecord(raw) ? str(raw, 'statement') : '',
      })).filter((row) => row.id && row.statement);
      if (fromGrades.length) return fromGrades;
    }
    return [];
  };

  for (const group of stability) {
    const hostId = str(group, 'submission_id');
    const attached = plan.find(
      (item) =>
        item.seats.size > 0 &&
        ((item.internal && item.internal === hostId) || item.sub.catalogSubmissionId === hostId),
    );
    let item = attached;
    let seats = attached?.seats ?? new Map<string, string>();
    const legacyStatements = legacyStatementsOf(group);
    if (!item) {
      let best: (typeof plan)[number] | undefined;
      let bestHits = 0;
      for (const candidate of plan) {
        if (!candidate.rubric || candidate.statements.length === 0) continue;
        const texts = new Set(candidate.statements.map((row) => normalizeClaim(row.statement)));
        const hits = legacyStatements.filter((row) => row.statement && texts.has(normalizeClaim(row.statement))).length;
        if (hits > bestHits) {
          bestHits = hits;
          best = candidate;
        }
      }
      if (best && bestHits >= 10) {
        item = best;
        seats = mapLegacySeatIds(legacyStatements, best.statements);
      }
    }
    if (!item || !item.rubric || seats.size === 0) {
      if (fillMissing) {
        console.warn(`Stability ${str(group, 'id') || hostId} has no host task; fill-missing will not invent one.`);
        continue;
      }
      if (!hostId || !legacyStatements.length || !fallbackProject) {
        console.warn(`Stability ${str(group, 'id') || hostId} has no host task and no statements to reconstruct.`);
        continue;
      }
      let sub = (await database.select().from(submissions).where(eq(submissions.catalogSubmissionId, hostId)).limit(1))[0];
      if (!sub) {
        const title = legacyStatements[0]?.statement.replace(/^The (output document|document|submitted output)\s+/i, '').slice(0, 140) || `Stability ${hostId.slice(0, 8)}`;
        const source = { provenance: 'legacy-stability-orphan', submissionId: hostId, statements: Object.fromEntries(legacyStatements.map((row) => [row.id, row.statement])) };
        const [created] = await database
          .insert(submissions)
          .values({
            catalogSubmissionId: hostId,
            projectId: fallbackProject,
            statusId: null,
            title,
            source,
            sourceFingerprint: sourceFingerprint(source),
            landedAt: str(group, 'created_at') || new Date().toISOString(),
            lastSeenAt: str(group, 'created_at') || new Date().toISOString(),
            stage: 'parked',
          })
          .returning();
        sub = created!;
        reconstructed += 1;
      }
      let rubric = (await database.select().from(rubrics).where(eq(rubrics.submissionId, sub.id))).find((row) => row.isCurrent);
      let statements = rubric ? await database.select().from(rubricStatements).where(eq(rubricStatements.rubricId, rubric.id)) : [];
      seats = rubric ? mapLegacySeatIds(legacyStatements, statements) : new Map();
      if (!rubric || seats.size === 0) {
        rubric = await installFactoryVersion(database, sub.id, knownUser(str(group, 'created_by') || null), {
          seeds: [],
          statements: factoryStatementsFromLegacy(legacyStatements.map((row) => ({ statement: row.statement, claim_key: row.id }))),
          generation: { provenance: 'legacy-stability-orphan', catalogId: hostId, statements: legacyStatements.length },
        });
        statements = await database.select().from(rubricStatements).where(eq(rubricStatements.rubricId, rubric.id));
        seats = mapLegacySeatIds(legacyStatements, statements);
      }
      item = { sub, internal: hostId, rubric, statements, run: null, seats };
    }
    if (!item.rubric) {
      console.warn(`Stability ${hostId} still has no rubric after reconstruct.`);
      continue;
    }
    const { sub, rubric } = item;
    const refs = aiRefsFrom(group);
    const fileIds: string[] = [];
    const fileShas: string[] = [];
    for (const ref of refs.slice(0, 12)) {
      const storagePath = `ai-outputs/${sub.id}/legacy/${ref.id}-${ref.name.replace(/[\\/]/g, '_')}`;
      const existing = (await database.select().from(aiOutputFiles).where(eq(aiOutputFiles.storagePath, storagePath)).limit(1))[0];
      if (existing && !existing.removedAt) {
        fileIds.push(existing.id);
        fileShas.push(existing.sha256);
      }
    }
    const groupId = str(group, 'group_id') || crypto.randomUUID();
    const already = (await database.select({ id: stabilityPasses.id }).from(stabilityPasses).where(eq(stabilityPasses.groupId, groupId)).limit(1))[0];
    if (already) continue;
    const passes = Array.isArray(group['runs']) ? (group['runs'] as Record<string, unknown>[]) : [];
    let wrote = 0;
    for (const pass of passes) {
      const ordinal = Number(pass['ordinal'] ?? pass['passIndex'] ?? 0) || 1;
      const mapped = remapVerdicts(Object.keys(record(pass['answers'])).length ? record(pass['answers']) : record(pass['grades']), seats);
      const evidence = remapEvidence(Object.keys(record(pass['evidence'])).length ? record(pass['evidence']) : record(pass['grades']), seats);
      if (!Object.keys(mapped).length && typeof pass['scorePercent'] !== 'number') continue;
      await database.insert(stabilityPasses).values({
        rubricId: rubric.id,
        groupId,
        passIndex: ordinal,
        answers: mapped,
        evidence,
        errors: {},
        scorePercent: typeof pass['scorePercent'] === 'number' ? pass['scorePercent'] : null,
        model: typeof pass['model'] === 'string' ? pass['model'] : null,
        basis: {
          rubricRevision: rubric.revision,
          aiOutputIds: fileIds,
          aiOutputShas: fileShas,
          provenance: 'legacy-snapshot',
          matchedBy: attached ? 'id' : item.sub.catalogSubmissionId === hostId ? 'reconstructed' : 'wording',
        },
      });
      wrote += 1;
    }
    if (!wrote) continue;
    stabGroups += 1;
    if (group['accepted_at']) {
      const evals = record(group['evaluation']);
      const scores = Array.isArray(evals['scores']) ? (evals['scores'] as number[]).filter((n) => typeof n === 'number') : [];
      await database.insert(stabilityAcceptances).values({
        rubricId: rubric.id,
        groupId,
        acceptedBy: knownUser(str(group, 'accepted_by') || null),
        scores,
        spread: typeof evals['spread'] === 'number' ? evals['spread'] : 0,
        basis: { provenance: 'legacy-snapshot' },
      });
    }
    await pruneStabilityGroups(database, rubric.id);
  }

  const parseMarker = (raw: unknown): Record<string, unknown> | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  let fromAnswers = 0;
  for (const item of plan) {
    if (!item.internal || !item.rubric || item.seats.size === 0) continue;
    const runIds = new Set((runsByInternal.get(item.internal) ?? []).map((row) => str(row, 'id')));
    const answerRows = answers.filter((row) => runIds.has(str(row, 'run_id')));
    const byGroup = new Map<string, Record<string, unknown>[]>();
    let marker: Record<string, unknown> | null = null;
    for (const row of answerRows) {
      marker = parseMarker(record(row['questions'])['__observability_stability_acceptance']) ?? marker;
      const list = Array.isArray(row['autorate_runs']) ? (row['autorate_runs'] as Record<string, unknown>[]) : [];
      for (const pass of list) {
        if (!String(pass['source'] ?? '').startsWith('autorate_stability_')) continue;
        const groupId = str(pass, 'groupId', 'group_id');
        if (!groupId) continue;
        const bucket = byGroup.get(groupId) ?? [];
        bucket.push(pass);
        byGroup.set(groupId, bucket);
      }
    }
    const preferred = marker ? str(marker, 'groupId') : '';
    const complete = [...byGroup.entries()]
      .map(([groupId, passes]) => ({ groupId, passes }))
      .filter((row) => row.passes.length >= 3)
      .sort((a, b) => {
        if (a.groupId === preferred) return -1;
        if (b.groupId === preferred) return 1;
        const at = (passes: Record<string, unknown>[]) => passes.map((pass) => str(pass, 'at')).sort().at(-1) ?? '';
        return at(b.passes).localeCompare(at(a.passes));
      })[0];
    if (!complete) continue;
    const groupId = asGroupId(complete.groupId);
    const already = (await database.select({ id: stabilityPasses.id }).from(stabilityPasses).where(eq(stabilityPasses.groupId, groupId)).limit(1))[0];
    if (already) continue;
    let wrote = 0;
    const scores: number[] = [];
    for (const pass of complete.passes) {
      const ordinal = Number(pass['ordinal'] ?? pass['passIndex'] ?? 0) || wrote + 1;
      const mapped = remapVerdicts(Object.keys(record(pass['answers'])).length ? record(pass['answers']) : record(pass['grades']), item.seats);
      const evidence = remapEvidence(Object.keys(record(pass['evidence'])).length ? record(pass['evidence']) : record(pass['grades']), item.seats);
      if (!Object.keys(mapped).length && typeof pass['scorePercent'] !== 'number') continue;
      if (typeof pass['scorePercent'] === 'number') scores.push(pass['scorePercent']);
      await database.insert(stabilityPasses).values({
        rubricId: item.rubric.id,
        groupId,
        passIndex: ordinal,
        answers: mapped,
        evidence,
        errors: {},
        scorePercent: typeof pass['scorePercent'] === 'number' ? pass['scorePercent'] : null,
        model: typeof pass['model'] === 'string' ? pass['model'] : null,
        basis: { rubricRevision: item.rubric.revision, provenance: 'legacy-autorate-runs', legacyGroupId: complete.groupId },
      });
      wrote += 1;
    }
    if (!wrote) continue;
    fromAnswers += 1;
    stabGroups += 1;
    if (marker && str(marker, 'groupId') === complete.groupId) {
      const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
      await database.insert(stabilityAcceptances).values({
        rubricId: item.rubric.id,
        groupId,
        acceptedBy: knownUser(str(marker, 'acceptedBy') || null),
        scores,
        spread,
        basis: { provenance: 'legacy-observability-acceptance', acceptedAt: str(marker, 'acceptedAt'), calibrationPercent: marker['calibrationPercent'] },
      });
    }
    await pruneStabilityGroups(database, item.rubric.id);
  }

  console.log(`Wrote goldenJobs=${goldenJobs} humanOverrides=${humanRows} calibrations=${calRows} stabilityGroups=${stabGroups} reconstructedTasks=${reconstructed} fromAnswers=${fromAnswers} reviews=${reviewsWritten} aiFiles=${files} (${Math.round(fileBytes / 1024)} KB)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
