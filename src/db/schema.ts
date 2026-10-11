/**
 * Drizzle mirror of drizzle/0001_init.sql.
 *
 * The SQL migration is the source of truth (constraints, checks, partial
 * indexes live there). This file exists for typed queries; the pglite test
 * suite applies the SQL and queries through these definitions, which catches
 * drift between the two.
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const app = pgSchema('app');

export const ROLES = ['admin', 'pm', 'rubric_creator', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = ['rubric', 'review', 'stability', 'handoff', 'done', 'parked'] as const;
export type Stage = (typeof STAGES)[number];

export const REVIEW_STATUSES = ['pending', 'changes_requested', 'approved'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const HANDOFF_STATUSES = [
  'ready_for_review',
  'bounced',
  'stability_pass',
  'final_review_pass',
  'client_visible',
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const JOB_KINDS = ['rubric_generate', 'golden_autorate', 'stability_run'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const FAMILIES = ['format', 'content', 'visual'] as const;
export type Family = (typeof FAMILIES)[number];

/** One line in a job's visible progress log (the legacy "stage table"). */
export interface JobStage {
  name: string;
  detail: string;
  at: string;
  state: 'done' | 'active' | 'failed';
}

export interface JobProgress {
  done?: number;
  total?: number;
  note?: string;
  stages?: JobStage[];
  /** Rubric generation: per-seed outcome tally. */
  seeds?: { total: number; ok: number; thin: number; failed: number };
  /** Stability: live per-pass scores as they land. */
  passes?: Record<string, number | null>;
}

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const profiles = app.table('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  isActive: boolean('is_active').notNull().default(true),
  passwordHash: text('password_hash'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const AUTH_TOKEN_PURPOSES = ['invite', 'recover'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

export const authTokens = app.table('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: AUTH_TOKEN_PURPOSES }).notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const userRoles = app.table('user_roles', {
  userId: uuid('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ROLES }).notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: ts('granted_at').notNull().defaultNow(),
});

export const watchedProjects = app.table('watched_projects', {
  projectId: text('project_id').primaryKey(),
  label: text('label').notNull().default(''),
  workStatusId: text('work_status_id').notNull().default(''),
  handoffStatusId: text('handoff_status_id').notNull().default(''),
  statusIds: jsonb('status_ids').$type<string[]>().notNull().default([]),
  project: jsonb('project').$type<unknown>(),
  projectFetchedAt: ts('project_fetched_at'),
  addedBy: uuid('added_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const submissions = app.table('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogSubmissionId: text('catalog_submission_id').notNull(),
  projectId: text('project_id').notNull(),
  statusId: text('status_id'),
  title: text('title').notNull().default(''),
  source: jsonb('source').$type<Record<string, unknown>>().notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  landedAt: ts('landed_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  upstreamChangedAt: ts('upstream_changed_at'),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  stage: text('stage', { enum: STAGES }).notNull().default('rubric'),
  rubricAssigneeId: uuid('rubric_assignee_id'),
  rubricClaimedAt: ts('rubric_claimed_at'),
  reviewerId: uuid('reviewer_id'),
  reviewClaimedAt: ts('review_claimed_at'),
  lastClaimedAt: ts('last_claimed_at'),
  reviewStatus: text('review_status', { enum: REVIEW_STATUSES }),
  reviewRubricId: uuid('review_rubric_id'),
  handoffStatus: text('handoff_status', { enum: HANDOFF_STATUSES }),
  handoffBasis: jsonb('handoff_basis').$type<Record<string, unknown>>(),
  pushedAt: ts('pushed_at'),
  pushReceipt: jsonb('push_receipt').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const submissionEvents = app.table('submission_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiOutputFiles = app.table('ai_output_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  storagePath: text('storage_path').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  removedAt: ts('removed_at'),
});

export const rubrics = app.table('rubrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  seeds: jsonb('seeds').$type<string[]>().notNull().default([]),
  generation: jsonb('generation').$type<Record<string, unknown>>().notNull().default({}),
  isCurrent: boolean('is_current').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const rubricStatements = app.table('rubric_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  family: text('family', { enum: FAMILIES }).notNull(),
  tag: text('tag').notNull(),
  statement: text('statement').notNull(),
  notes: text('notes').notNull().default(''),
  scope: text('scope', { enum: ['output', 'inputs'] }).notNull().default('output'),
  inputFileIds: text('input_file_ids').array().notNull().default([]),
  outputFile: text('output_file'),
  claimKey: text('claim_key'),
  origin: text('origin', { enum: ['factory', 'bank', 'manual', 'import'] }).notNull().default('manual'),
  lint: jsonb('lint').$type<Record<string, unknown>>(),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const goldenRatings = app.table('golden_ratings', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  statementId: uuid('statement_id').notNull().references(() => rubricStatements.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id'),
  source: text('source', { enum: ['ai', 'human'] }).notNull(),
  verdict: boolean('verdict'),
  evidence: text('evidence').notNull().default(''),
  error: text('error'),
  reason: text('reason'),
  model: text('model'),
  basis: jsonb('basis').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const calibrations = app.table('calibrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id'),
  answers: jsonb('answers').$type<Record<string, boolean>>().notNull(),
  evidence: jsonb('evidence').$type<Record<string, string>>().notNull().default({}),
  scorePercent: numeric('score_percent', { mode: 'number' }).notNull(),
  basis: jsonb('basis').$type<Record<string, unknown>>().notNull(),
  submitted: boolean('submitted').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const reviewFeedback = app.table('review_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  rubricId: uuid('rubric_id'),
  reviewerId: uuid('reviewer_id'),
  decision: text('decision', { enum: ['approved', 'changes_requested'] }).notNull(),
  feedback: text('feedback').notNull().default(''),
  calibrationId: uuid('calibration_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const stabilityPasses = app.table('stability_passes', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull(),
  jobId: uuid('job_id'),
  passIndex: smallint('pass_index').notNull(),
  answers: jsonb('answers').$type<Record<string, boolean | null>>().notNull(),
  evidence: jsonb('evidence').$type<Record<string, string>>().notNull().default({}),
  errors: jsonb('errors').$type<Record<string, string>>().notNull().default({}),
  scorePercent: numeric('score_percent', { mode: 'number' }),
  model: text('model'),
  basis: jsonb('basis').$type<Record<string, unknown>>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const FLIP_NOTE_ACTIONS = ['acknowledged', 'rewrite_requested'] as const;
export type FlipNoteAction = (typeof FLIP_NOTE_ACTIONS)[number];

export const stabilityFlipNotes = app.table('stability_flip_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull(),
  statementId: uuid('statement_id').notNull().references(() => rubricStatements.id, { onDelete: 'cascade' }),
  action: text('action', { enum: FLIP_NOTE_ACTIONS }).notNull(),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const stabilityAcceptances = app.table('stability_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull(),
  acceptedBy: uuid('accepted_by'),
  scores: numeric('scores', { mode: 'number' }).array().notNull(),
  spread: numeric('spread', { mode: 'number' }).notNull(),
  calibrationId: uuid('calibration_id'),
  basis: jsonb('basis').$type<Record<string, unknown>>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const jobs = app.table('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: JOB_KINDS }).notNull(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  rubricId: uuid('rubric_id'),
  requestId: uuid('request_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
  progress: jsonb('progress').$type<JobProgress>().notNull().default({}),
  checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  leaseToken: uuid('lease_token'),
  leaseUntil: ts('lease_until'),
  heartbeatAt: ts('heartbeat_at'),
  deadlineAt: ts('deadline_at').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
});

export const geminiFiles = app.table('gemini_files', {
  sha256: text('sha256').primaryKey(),
  uri: text('uri').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Tasks that have attached this sha. The reaper waits until all of them have left grading. */
export const geminiFileUses = app.table(
  'gemini_file_uses',
  {
    sha256: text('sha256').notNull(),
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sha256, t.submissionId] })],
);

/** First-download identity of a Catalog file. Lets later jobs skip the GET and the Files API upload. */
export const catalogFileCache = app.table('catalog_file_cache', {
  fileId: text('file_id').primaryKey(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  etag: text('etag'),
  sha256: text('sha256').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const derivatives = app.table('derivatives', {
  sourceSha256: text('source_sha256').notNull(),
  kind: text('kind').notNull(),
  storagePath: text('storage_path').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  tool: text('tool').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const webhookEvents = app.table('webhook_events', {
  eventId: text('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  submissionId: text('submission_id').notNull().default(''),
  projectId: text('project_id').notNull().default(''),
  statusId: text('status_id').notNull().default(''),
  occurredAt: ts('occurred_at'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  outcome: text('outcome').notNull().default('received'),
  detail: text('detail').notNull().default(''),
});

export type Profile = typeof profiles.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type SubmissionEvent = typeof submissionEvents.$inferSelect;
export type AiOutputFile = typeof aiOutputFiles.$inferSelect;
export type Rubric = typeof rubrics.$inferSelect;
export type RubricStatement = typeof rubricStatements.$inferSelect;
export type GoldenRating = typeof goldenRatings.$inferSelect;
export type Calibration = typeof calibrations.$inferSelect;
export type StabilityPass = typeof stabilityPasses.$inferSelect;
export type StabilityFlipNote = typeof stabilityFlipNotes.$inferSelect;
export type StabilityAcceptance = typeof stabilityAcceptances.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type WatchedProject = typeof watchedProjects.$inferSelect;
