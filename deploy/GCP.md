# GCP cutover (when billing exists)

Nothing in this repo creates a GCP project, enables APIs, or spends money.
Use this file the day someone with billing access provisions the project.

Target shape, same region throughout (default `europe-west1`):

| piece | service | notes |
| --- | --- | --- |
| Web | Cloud Run | `start.sh web`, `RUN_WORKER=0`, `--min-instances=1` only if you need zero cold start |
| Worker | Cloud Run | `start.sh worker`, listens on `$PORT` at `/health` |
| Database | Cloud SQL Postgres 16 | private IP + Cloud SQL Auth Proxy / connector. Schema is `app.*` |
| Files | GCS private bucket | `STORAGE_DRIVER=gcs` |
| Auth | stay on Supabase Auth | same project URL + anon key so profile UUIDs keep working |
| Image | Artifact Registry | `deploy/cloudbuild.yaml` |

## Provision (operator with billing)

1. Create the GCP project and enable Cloud Run, Cloud SQL, Artifact Registry, Secret Manager, Cloud Build.
2. Cloud SQL instance + database `gdp` + user. Capture the connection name `PROJECT:REGION:INSTANCE`.
3. GCS bucket, uniform access, public access prevented. Grant the Cloud Run service account `roles/storage.objectAdmin` on that bucket and `roles/cloudsql.client` on the instance.
4. Build the image with Cloud Build (or `docker build` locally and push).
5. Cloud Run web + worker, same image, same region as Cloud SQL. Attach the Cloud SQL instance. Set secrets (never bake `.env.local` into the image).

Web env:

```
AUTH_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=          # existing live Auth project
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_JWT_SECRET=               # if the project is HS256
DATABASE_URL=postgresql://gdp:PASSWORD@/gdp?host=/cloudsql/PROJECT:REGION:INSTANCE
STORAGE_DRIVER=gcs
STORAGE_BUCKET=your-private-bucket
RUN_WORKER=0
PUBLIC_APP_URL=https://your-cloud-run-url
GEMINI_API_KEY=
WIRESTOCK_API_TOKEN=
WIRESTOCK_WEBHOOK_SECRET=
```

Worker env: same `DATABASE_URL`, Gemini, Catalog, `STORAGE_DRIVER=gcs`. No `RUN_WORKER` needed.

## Data move (never writes to live Supabase)

Auth stays on Supabase, so users keep the same UUIDs. Task rows, seats and the current rubric live in Cloud SQL.

```bash
# 1. Read-only copy of live public.* (already done locally if tmp/supabase-snapshot exists)
npm run db:snapshot-supabase

# 2. Point DATABASE_URL at Cloud SQL (proxy on 127.0.0.1:5432)
cloud-sql-proxy PROJECT:REGION:INSTANCE --port=5432
npm run db:migrate

# 3. See the plan, then write
npm run db:import-snapshot
npm run db:import-snapshot -- --apply
```

`--apply` refuses if `DATABASE_URL` is a Supabase host. Existing `app.submissions` rows are left alone unless you pass `--replace`. Golden / stability / human AI eval are not migrated — they are bound to file hashes the new app does not have; re-run those jobs after cutover.

Optional `--sync-catalog` refreshes each task from the Catalog after the snapshot payload is inserted. Default is offline from the snapshot so cutover does not depend on Catalog availability.
