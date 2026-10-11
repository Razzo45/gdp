# Architecture

## Principles

1. **The gates are the product.** Golden 100% · human AI eval 20–50% ·
   Stability 3 passes, spread ≤ 5, each within 20 of the human score,
   explicitly accepted. They live in one file (`src/domain/gates.ts`), are not
   configurable, and are tested.
2. **The server owns the data.** One schema (`app`), no RLS, no SQL business
   logic. Every write goes through a service that checks the seat and the
   stage. Clients never talk to Postgres or Storage.
3. **Auth is cheap.** The proxy verifies the Supabase JWT locally (jose) on
   every request — no network — and forwards the subject in a header it strips
   from inbound traffic. Roles come from a 60 s in-process cache. The only
   network auth call is a session refresh within 90 s of token expiry.
4. **Nothing is lost.** Rubric edits autosave with optimistic concurrency.
   Ratings, calibrations and stability passes are append-only and carry the
   *basis* they were computed on. Jobs checkpoint and resume.
5. **Evidence is bound to inputs.** Every AI verdict records the statement
   hash and the sha256 of the files it saw. A changed statement makes its
   Golden rating stale; a changed AI output blocks Stability until the
   calibration is redone.

## Request path

```
browser ──▶ src/proxy.ts (JWT verify, cookie refresh) ──▶ route / page
                                                            │
                                               currentActor() (cached roles)
                                                            │
                                                     lib/services/* (tx)
                                                            │
                                                      Postgres (app.*)
```

Pages are server components that call services directly. Mutations go through
`src/app/api/**` routes wrapped by `route()` (`src/lib/api.ts`): actor
resolution, zod body validation, `ServiceError → HTTP status`.

The task workspace polls `GET /api/submissions/:id` every 2.5 s **only while a
job is queued or running**; otherwise it refreshes after its own actions.

## Data model (drizzle/0001_init.sql)

| table | role |
| --- | --- |
| `profiles`, `user_roles` | identity mirror (Supabase Auth is the source) and role grants |
| `watched_projects` | Catalog projects we import from; work/handoff status ids; cached project declaration |
| `submissions` | one row per Catalog submission: source snapshot + fingerprint, `landed_at`, `last_seen_at`, stage, seats (`rubric_assignee_id`, `reviewer_id`, claimed-at timestamps, `last_claimed_at`), review/handoff state, push receipt |
| `submission_events` | audit trail |
| `ai_output_files` | creator-uploaded AI outputs (private bucket, sha256) |
| `rubrics`, `rubric_statements` | versions (factory installs a new version) and statements with scope, tag, lint |
| `golden_ratings` | AI and human verdicts per statement with basis (`statementHash`, file fingerprints) |
| `calibrations` | reviewer answers; newest row is the working copy; `submitted` locks the score |
| `review_feedback` | approve / changes-requested decisions |
| `stability_passes`, `stability_acceptances` | three passes per group; explicit acceptance |
| `jobs` | the only queue |
| `gemini_files`, `derivatives` | Files API cache by sha256; rendered PDFs by source hash |
| `webhook_events` | delivery dedupe and outcome |

Invariants enforced in SQL: one current rubric per submission (partial unique
index), one active job per `(submission, kind)` (partial unique index), unique
`(rubric, position)`, unique `(group, pass_index)`, unique `request_id`.

## Stages and seats

`stage ∈ rubric → review → stability → handoff → done`. Transitions happen only
inside service transactions:

- `sendToReview`: rubric seat, stage `rubric`, Golden gate ok, AI output present.
- `decideReview('approved')`: review seat, submitted calibration in band → `stability`.
- `decideReview('changes_requested')`: feedback ≥ 10 chars → back to `rubric`.
- `acceptStability`: rubric seat, gate ok on the newest group → `handoff`.
- `setHandoffStatus`: ladder `ready_for_review → bounced | stability_pass → final_review_pass`; `bounced` → `rubric`.
- `pushToCatalog`: requires `final_review_pass`; sets `client_visible` and stage `done`.

Seats: `claimSeat` is a conditional update (`where holder is null`), so two
people cannot take the same seat. Controllers (`pm`/`admin`) may assign or
release anyone. Every claim/release/assign updates `last_claimed_at`; the PM
"Who holds what" page reads straight from these columns.

The rubric is editable only by the seat holder and only in stage `rubric`; AI
output files may be added/removed only in stage `rubric`, so the reviewer and
the Stability runs grade the same bytes.

## Rubric editing

`saveStatements(actor, id, { revision, upserts, deletes, order })`:

- `SELECT … FOR UPDATE` on the rubric row serialises editors;
- `revision` mismatch → 409 with the current revision and statements, which
  the editor adopts (drafts for untouched rows are preserved);
- two-phase renumber avoids transient `(rubric, position)` collisions;
- local lint runs on every save and is stored on the statement; failures are
  warnings for humans, blocking for factory output;
- editing a factory statement's text flips its origin to `manual`.

The client debounces 700 ms, flushes on unmount/`beforeunload`, and adopts
server state on 409.

## Rubric factory

`runFactory` ports the reference prompts: expert-seed enhancer → per-seed
statement bank → deterministic `assemble` (lint filter, claim-key and Jaccard
≥ 0.72 collapse, round-robin across seeds into family quotas 5/15/30 of 50,
spare redistribution) → LLM lint in chunks of 15; a rewrite is applied only
if it passes local lint and stays close to the original. The result is
installed as a new rubric version; the old one stays for audit.

## Autorater

`gradeStatements` groups statements by **payload key** (`scope`, `outputFile`,
`inputFileIds`) so each Gemini call carries exactly the files the curator
declared for those statements, then grades in batches of `AUTORATE_BATCH_SIZE`
(default 10) with structured JSON output (`responseJsonSchema`) and
`thinkingBudget: 0`. Skipped ids are retried alone once, then recorded as
errors. A single defect inventory is computed per run and shared across
batches and passes.

Golden autorate persists per batch; a crashed job resumes from its checkpoint
and does not regrade stored statements whose basis still matches.

Stability runs three passes in parallel over the AI output with the same
defect inventory; passes already stored in the group are reused on retry.

## Media preparation

`prepareFile(file, role)`:

| input | delivery |
| --- | --- |
| image / pdf / audio / video / text | native (inline ≤ 2 MB, else Files API, cached by sha256 for 47 h) |
| pptx / docx / xlsx | `pdf_from_office`: LibreOffice renders once per content hash (≤ 2 concurrent, 180 s, isolated profile) → PDF cached in the private bucket (`derivatives`), **plus** a deterministic *FILE FACTS* manifest from the OOXML (slide count, aspect, hidden slides, notes, media, fonts, charts, transitions) |
| pptx / docx / xlsx without a renderer | `text_digest`: manifest + full text in reading order, with an explicit *NO RENDER AVAILABLE* instruction so the model does not guess at visuals |
| zip | expanded (≤ 25 entries, 300 MB) and each entry prepared recursively |
| anything else / > 2 GB | `NOT ATTACHED` notice so a missing file is never silently "fine" |

## Jobs

One table. `claimNext` uses `FOR UPDATE SKIP LOCKED`, takes a 90 s lease,
and also reclaims running jobs whose lease expired (`attempts < max_attempts`).
A crashed job that has used every attempt is failed on the next worker poll
so it does not sit `running` until the 2-hour deadline.
Handlers call `tick()` (heartbeat + progress + checkpoint); a lost lease throws
`LeaseLost` and the other worker continues from the checkpoint. The worker is
started by `instrumentation.ts` inside the web process (`RUN_WORKER=1`) or
by `npm run worker`.

Gemini calls share a process-wide semaphore (`GEMINI_CONCURRENCY`) and a
cooldown on 429; transport/5xx are retried 4×; schema rejections fall back to
JSON-mode without schema and are validated with zod.

## Catalog integration

- **Inbound**: webhook (`x-wirestock-signature`, `x-wirestock-timestamp`, 5-min
  freshness, 64 KB cap) is a trigger only; we fetch the submission with our
  token and import it only for watched projects. Manual import and re-sync
  exist for PMs/creators.
- **Files**: golden and input files are downloaded from presigned S3 URLs at
  job time; expired URLs trigger a re-sync; fingerprints strip signing
  parameters so unchanged files hash identically.
- **Outbound**: `pushToCatalog` writes `rubrics` (`s001…` rows shaped to the
  project's declared fields, ASCII-converted), `taskPerformance` (three
  sentences, only when all are available), and `prompt`, then walks the
  workflow from the current status to the configured handoff status via BFS
  over `next|approve|submit|resubmit|assign` triggers. A push lease on the
  submission row prevents double pushes and expires after 10 minutes. If the
  Catalog already shows the handoff status, a retry writes the local receipt
  instead of dead-ending.

## Security notes

- Service role key and Catalog token never leave the server; the browser gets
  only the anon key.
- Verified-identity headers are deleted from inbound requests before being set.
- All file reads by the browser go through redirect routes that issue fresh,
  short-lived signed URLs after a visibility check.
- Uploads are capped (12 AI outputs, 2 GB each) and go to object storage via
  a signed PUT (not through the Next body). MIME is derived from the
  extension server-side, bytes are hashed.
- Webhook body is read as raw text and verified before parsing.
- Human overrides of Golden verdicts require a reason and are stored
  separately from AI verdicts.
