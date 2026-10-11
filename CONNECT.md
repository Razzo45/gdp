# Connect this image on AWS

This branch is the full GDP app, ready for the AWS host they already use.
Connectors start empty. Fill them, build the image, run migrations, then use
the app.

LibreOffice is already in the image. Do not install it on the host.

```bash
cp .env.example .env          # fill the connectors below
docker build -t gdp .
docker run --rm --env-file .env gdp ./start.sh migrate
docker run --rm -p 8080:8080 --env-file .env gdp
```

Or `docker compose up --build` after `.env` is filled. Compose runs **web**
(the app + the job worker in the same process). Split web/worker later if
you want.

Ready when `GET /api/health` returns `{ "ok": true, "renderer": true }`.

Host it on ECS / Fargate, App Runner, or an EC2 box that runs the container.
The image listens on `PORT` (default `8080`).

---

## 1. Database — RDS / Aurora Postgres

`DATABASE_URL` = a Postgres 16+ the task can reach. The app owns schema
`app.*` only. It creates that schema on migrate.

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require
```

Use the RDS proxy / PgBouncer transaction pooler if you have one. Prepared
statements are already off.

Do **not** point this at a live GDP / Catalog / `public.wirestock_*`
database. Those stay read-only elsewhere.

Then: `docker run --rm --env-file .env gdp ./start.sh migrate`

---

## 2. Auth — still Supabase (identity only)

Sign-in stays on the existing Supabase project. App data does not.

```
AUTH_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # invites only; files go to S3
SUPABASE_JWT_SECRET=                # HS256 projects; leave empty for JWKS
BOOTSTRAP_ADMIN_EMAILS=
```

Add `<PUBLIC_APP_URL>/auth/callback` to the Supabase redirect allow-list.

Closed-box / no Supabase: `AUTH_MODE=local` and a long `AUTH_LOCAL_SECRET`.
That is for a private demo, not a team host.

---

## 3. Files — private S3 bucket

AI outputs (including multi-GB video) go to **your** bucket via a signed PUT.
Golden / Catalog files stay on Catalog S3; this app does not write there.

```
STORAGE_DRIVER=s3
STORAGE_BUCKET=
AWS_REGION=
```

Keys are optional on ECS / App Runner if the task role can `s3:GetObject`,
`s3:PutObject`, `s3:DeleteObject`, `s3:HeadObject` on that bucket. Set
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` only when there is no role.

Bucket: private, block public access. CORS for the public origin so the
browser can PUT / GET directly (same idea as Catalog S3):

```json
[
  {
    "AllowedHeaders": ["Content-Type", "*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": ["https://your-host.example"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Do this when the bucket is provisioned, not from this repo.

---

## 4. Mail — SES assignment template

Same live template: `submission_assigned`.

```
AWS_REGION=
SES_FROM_EMAIL=
SES_ASSIGNMENT_TEMPLATE=submission_assigned
```

Task role needs `ses:SendTemplatedEmail`. Keys only if there is no role.
Leave `SES_FROM_EMAIL` empty to skip mail; assign still succeeds.

---

## 5. Model — Gemini

```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
```

Google AI Studio key (`AIza…` / `AQ.…`). Not an OpenAI key. Admission is
shared across instances through `app.gemini_admission_*` on your Postgres.

---

## 6. Catalog — Wirestock

```
WIRESTOCK_API_BASE_URL=https://api.wirestock.io/data-program/core
WIRESTOCK_API_TOKEN=
WIRESTOCK_WEBHOOK_SECRET=
```

Token reads and writes submissions. Webhook secret verifies inbound Catalog
events. Point the Catalog webhook at `PUBLIC_APP_URL/api/hooks/wirestock`.

---

## 7. Public URL

```
PUBLIC_APP_URL=https://your-host.example
```

HTTPS origin users open. Used in invite, reset, and assignment-mail links.

---

## 8. Already in the image — do not connect

| Piece | Notes |
| --- | --- |
| Next.js app | `output: 'standalone'`, binds `0.0.0.0:$PORT` |
| Job worker | `RUN_WORKER=1` in the same container (default). Set `0` and run a second task with `./start.sh worker` to split them. |
| LibreOffice | `LIBREOFFICE_BIN=/usr/bin/soffice` — PPTX/DOCX/XLSX → PDF stills |
| Migrations | `./start.sh migrate` against `DATABASE_URL` |

---

## One-container env (minimum)

Copy `.env.example` → `.env` and fill at least:

1. `DATABASE_URL` (RDS / Aurora)
2. Auth trio (`NEXT_PUBLIC_SUPABASE_*`)
3. `STORAGE_DRIVER=s3` + `STORAGE_BUCKET` + `AWS_REGION`
4. `GEMINI_API_KEY`
5. `WIRESTOCK_API_TOKEN` + `WIRESTOCK_WEBHOOK_SECRET`
6. `PUBLIC_APP_URL`

Everything else has a default. IAM role covers S3 and SES when the task
has one.

---

## After it is up

1. Open `PUBLIC_APP_URL`. Sign in. Bootstrap emails become admin on first sign-in.
2. Settings → watch the Catalog projects you own.
3. Health: `{ ok: true, renderer: true }` means Postgres and Impress are live.
4. AI files upload straight to S3. CORS must allow the public origin.
