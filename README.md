# GDP — Golden Data Program platform

Multi-user platform for building rubrics against Catalog tasks, autorating the
Golden output, running the human AI evaluation, proving Stability, and pushing
the result back to the Catalog.

```
Catalog webhook ──▶ task lands ──▶ creator claims rubric seat
   ▶ generate / edit rubric (autosaves, real-time CAS)
   ▶ Golden autorate must reach 100%            (gate 1)
   ▶ upload AI output ▶ send to review
   ▶ reviewer claims review seat ▶ human AI eval ▶ score in 20–50%   (gate 2)
   ▶ approve ▶ creator runs Stability (3 × autorater on the AI output)
   ▶ spread ≤ 5 pts, each within 20 pts of the human score, accepted (gate 3)
   ▶ handoff ladder ▶ push rubric + taskPerformance to the Catalog
```

## Stack

Next.js 16 (App Router, Node runtime) · React 19 · TypeScript · Tailwind 4 ·
Drizzle + postgres-js · Supabase (Auth, Postgres, private Storage) ·
`@google/genai` · LibreOffice **in the Cloud Run / Replit image** (Office → PDF → one image per slide) · vitest + pglite.

## Local setup

```bash
cp .env.example .env.local      # fill in Supabase, Gemini, Catalog values
npm install
npm run db:migrate              # applies drizzle/*.sql to DATABASE_URL
npm run db:grant-admin -- you@company.com   # or set BOOTSTRAP_ADMIN_EMAILS
npm run dev                     # http://localhost:3000
```

Supabase: enable Email auth; set the Site URL and add
`<PUBLIC_APP_URL>/auth/callback` to the redirect allow-list. Nothing else is
required — the app owns its schema (`app.*`), has no RLS and no SQL functions
besides one `updated_at` trigger.

## Local development without Supabase or the Catalog

Any Postgres (Neon, Docker, local) plus a Gemini key is enough. Identity,
storage and the Catalog are replaced by development stand-ins; the gates,
engines, jobs and UI are the real ones.

```
AUTH_MODE=local                      # seeded users, shared password
AUTH_LOCAL_SECRET=<any 16+ chars>
DATABASE_URL=postgresql://…           # e.g. a Neon branch
GEMINI_API_KEY=…
STORAGE_DRIVER=local                 # files under tmp/storage
WIRESTOCK_API_BASE_URL=http://localhost:4010
WIRESTOCK_API_TOKEN=mock
WIRESTOCK_WEBHOOK_SECRET=local-webhook-secret
PUBLIC_APP_URL=http://localhost:3000
```

```bash
npm run db:migrate
npm run mock:catalog       # terminal 1: fake Catalog API with fixture tasks + files
npm run db:seed            # users for every role, watched project, imports the fixtures
npm run dev                # terminal 2: http://localhost:3000
```

`/login` lists the seeded users (`admin@gdp.local`, `pm@`, `ana@`, `ben@`,
`rita@`, `sam@`; password `gdp-dev`). The seed assigns two tasks to the two
creators. "AI output" files to upload are written to `fixtures/ai-outputs/`;
they differ from the Golden on purpose (missing slides, wrong figure, other
font, hidden draft slide, typo). `curl -X POST localhost:4010/emit/<id>` sends
a signed webhook; `localhost:4010/state` shows what was saved and moved by a
push. On Cloud Run the image already ships LibreOffice; the worker renders each
PPTX slide to a still. This laptop does not need soffice. `/api/health` returns
`renderer: true` when the image is wired.

## GCP

The repo is ready to deploy on Cloud Run + Cloud SQL + GCS. It does **not**
create a GCP project (billing is required for that). See `deploy/GCP.md`.

```
AUTH_MODE=supabase               # live Supabase Auth — same user UUIDs as app.profiles
DATABASE_URL=…                   # Cloud SQL (unix socket or Auth Proxy)
STORAGE_DRIVER=gcs
STORAGE_BUCKET=your-private-bucket
RUN_WORKER=0                     # web service; worker is a second Cloud Run
```

Data move from live Supabase (`public.*`) into the new `app.*` database:

```bash
npm run db:snapshot-supabase     # read-only, writes tmp/supabase-snapshot/
npm run db:import-snapshot       # dry-run against DATABASE_URL
npm run db:import-snapshot -- --clone   # write users/tasks/rubrics; drop leftover fixture rows
npm run db:import-eval -- --apply       # Golden, human AI eval, stability, AI files
```

`--apply` refuses a Supabase `DATABASE_URL`. Then:

```bash
npm run db:import-eval -- --apply       # Golden, human overrides, human AI eval, stability, reviews, AI files
npm run db:repair-pipeline -- --apply   # retag stages from the Catalog graph (optional --no-observe)
```

Eval rows are remapped onto the new statement ids. Four live AI storage objects
were already gone upstream and cannot be copied.

## Host the image

This app ships as one Docker image. Connectors are empty on purpose.

See **[CONNECT.md](CONNECT.md)** — database, auth, storage, Gemini, Catalog,
public URL — then:

```bash
cp .env.example .env
docker build -t gdp .
docker run --rm --env-file .env gdp ./start.sh migrate
docker run --rm -p 8080:8080 --env-file .env gdp
```

## Replit

`.replit` and `replit.nix` are included. Set the variables from `.env.example`
as Secrets. The build step runs migrations; the web process also runs the job
worker (`RUN_WORKER=1`). `replit.nix` installs LibreOffice so decks are
rendered to PDF for grading; without it Office files are graded from their
OOXML manifest and text digest.

Health: `GET /api/health` (checks the database).

## Scripts

| command | purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest (domain, catalog, office, services on in-memory Postgres) |
| `npm run db:migrate` | apply pending `drizzle/*.sql` |
| `npm run db:grant-admin -- email` | create/invite a user and grant `admin` |
| `npm run db:seed` | local-mode users, watched fixture project, fixture tasks |
| `npm run db:snapshot-supabase` | read-only copy of live `public.*` into `tmp/supabase-snapshot/` |
| `npm run db:import-snapshot` | dry-run / `--apply` that snapshot into `app.*` on `DATABASE_URL` |
| `npm run db:import-eval` | Golden, human AI eval, stability, reviews, AI files |
| `npm run db:repair-pipeline` | retag stages from the Catalog graph |
| `npm run mock:catalog` | fake Catalog API on :4010 (fixtures, save/transition log, webhook emitter) |
| `npm run worker` | standalone job worker (when `RUN_WORKER=0` on web) |

## Roles

Roles are permission bundles; a user may hold several.

| role | can |
| --- | --- |
| `admin` | everything, users, watched projects |
| `pm` | see all tasks and who holds them, assign/release seats, final review / bounce, projects |
| `rubric_creator` | claim rubric seat, generate/edit rubric, Golden, upload AI output, Stability, push |
| `reviewer` | claim review seat, human AI evaluation, approve / request changes |

## Where things are

```
drizzle/0001_init.sql        the schema (source of truth, 15 tables)
src/db                        drizzle mirror, client, migration runner
src/domain                    pure rules: tags/quotas, lint, gates, assemble, fingerprints
src/lib/auth                  local JWT verify, actor cache, permissions
src/lib/catalog               Catalog client, payload readers, export shaping, webhook HMAC
src/lib/ai                    Gemini client, media preparation, OOXML facts
src/lib/engines               rubric factory, batched autorater
src/lib/jobs                  single job table, worker, handlers, start helpers
src/lib/services              submissions/seats, rubric, files, review, stability, handoff, admin, view
src/app/api                   thin zod-validated routes over services
src/app/(app)                 dashboard, tasks, task workspace, claims, settings
src/components/task           RubricEditor, ReviewPanel, StabilityPanel, HandoffPanel, …
test/                         vitest suites (pglite for services)
```

See `ARCHITECTURE.md` for the design and `MIGRATION.md` for what changed from
the legacy app and how to move data.
