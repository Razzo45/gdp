# Connect this image and run it

This branch is the full GDP app in one Docker image. Nothing is wired to a
vendor. You fill the connectors, host the container, run migrations, then use
the app.

LibreOffice is already in the image. Do not install it on the host.

## Slot in

```bash
cp .env.example .env          # fill the connectors below
docker build -t gdp .
docker run --rm --env-file .env gdp ./start.sh migrate
docker run --rm -p 8080:8080 --env-file .env gdp
```

Or `docker compose up --build` after `.env` is filled. Compose runs **web**
(the app + the job worker in the same process). That is enough for one
instance. Split web/worker later if you want.

Ready when `GET /api/health` returns `{ "ok": true, "renderer": true }`.

Host it anywhere that runs a container and a reachable HTTPS URL: Cloud Run,
Fly, Railway, ECS, a VM. The image listens on `PORT` (default `8080`).

---

## 1. Database — connect your Postgres here

`DATABASE_URL` = any Postgres 16+ the container can reach.

Neon, Cloud SQL, RDS, Supabase Postgres, a box you run — all fine. The app
owns the `app` schema only. It creates that schema on migrate.

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require
```

Use the transaction pooler if the host offers one (often port `6543`).
Prepared statements are already off.

Do **not** point this at a live GDP / Catalog / `public.wirestock_*`
database. Those stay read-only elsewhere.

Then: `docker run --rm --env-file .env gdp ./start.sh migrate`

---

## 2. Auth — connect sign-in here

`AUTH_MODE=supabase` (normal hosting):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # invites + Storage if you pick Supabase files
SUPABASE_JWT_SECRET=                # only for HS256 projects; leave empty for JWKS
```

First admins (optional): `BOOTSTRAP_ADMIN_EMAILS=you@company.com`

Closed-box / no Supabase: `AUTH_MODE=local` and set `AUTH_LOCAL_SECRET` to a
long random string. That is for a private demo, not a team host.

---

## 3. Files — connect object storage here

AI outputs (including multi-GB video) go to **your** bucket via a signed PUT.
Golden / Catalog files stay on Catalog S3; this app does not write there.

```
STORAGE_DRIVER=                     # gcs | supabase | local
STORAGE_BUCKET=                     # private bucket name
```

| Driver | What you connect |
| --- | --- |
| `gcs` | Private GCS bucket + the runtime service account can `objectAdmin`. CORS on the bucket for your public origin: `PUT` `GET` `HEAD`, header `Content-Type`. |
| `supabase` | Same project as Auth. Service role required. Private bucket; CORS already if that project is set up. |
| `local` | Disk inside the container. Only for a laptop. Do not host this way. |

---

## 4. Model — connect Gemini here

```
GEMINI_API_KEY=                     # Google AI Studio key (AIza… / AQ.…)
GEMINI_MODEL=gemini-3.8-flash       # optional
```

Not an OpenAI key. Without this, rubric / golden / stability jobs will not
grade.

---

## 5. Catalog — connect Wirestock here

```
WIRESTOCK_API_BASE_URL=https://api.wirestock.io/data-program/core
WIRESTOCK_API_TOKEN=
WIRESTOCK_WEBHOOK_SECRET=
```

Token reads and writes submissions. Webhook secret verifies inbound Catalog
events. Leave them empty only if you are running the local Catalog mock.

---

## 6. Public URL — connect the host name here

```
PUBLIC_APP_URL=https://your-host.example
```

Used in invite and password-reset links. Must be the HTTPS origin users open.

---

## 7. Already in the image — do not connect

| Piece | Notes |
| --- | --- |
| Next.js app | `output: 'standalone'`, binds `0.0.0.0:$PORT` |
| Job worker | `RUN_WORKER=1` in the same container (default). Set `0` and run a second container with `./start.sh worker` if you split them. |
| LibreOffice | `LIBREOFFICE_BIN=/usr/bin/soffice` — PPTX/DOCX/XLSX → PDF stills |
| Migrations | `./start.sh migrate` against `DATABASE_URL` |

---

## One-container env (minimum)

Copy `.env.example` → `.env` and fill at least:

1. `DATABASE_URL`
2. Auth trio (`NEXT_PUBLIC_SUPABASE_*` + service role if you want invites/files)
3. `STORAGE_DRIVER` + `STORAGE_BUCKET` (unless Auth service role + supabase)
4. `GEMINI_API_KEY`
5. `WIRESTOCK_API_TOKEN` + `WIRESTOCK_WEBHOOK_SECRET`
6. `PUBLIC_APP_URL`

Everything else has a default.

---

## After it is up

1. Open `PUBLIC_APP_URL`. Sign in. Bootstrap emails become admin on first sign-in.
2. Settings → watch the Catalog projects you own.
3. Health: `{ ok: true, renderer: true }` means Postgres and Impress are live.
4. AI files upload straight to the bucket. CORS must allow the public origin.
