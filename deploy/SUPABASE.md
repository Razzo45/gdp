# Isolated Supabase project (empty connectors)

Wait for the enterprise project from the CTO. Do **not** use the live GDP
project (`ccgbhvgfgptsoszimmya`) as `DATABASE_URL`. That one stays read-only.

When the new URL and keys arrive, put them in `.env.local` (never commit):

```
AUTH_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
DATABASE_URL=                 # transaction pooler, port 6543
STORAGE_DRIVER=supabase
STORAGE_BUCKET=gdp-private
BOOTSTRAP_ADMIN_EMAILS=
PUBLIC_APP_URL=
```

Then from this repo:

```bash
npm run db:migrate
```

That applies `drizzle/0001`–`0007` into schema `app.*` only. You do not run
the SQL by hand.

Dashboard on the **new** project:

1. Email auth on.
2. Site URL + `<PUBLIC_APP_URL>/auth/callback` on the redirect allow-list.
3. Storage: private bucket `gdp-private` (created on first use if the service
   role may create buckets). CORS for the public origin: `PUT` `GET` `HEAD`,
   header `Content-Type`.

This project is GDP-only. First sign-in creates the profile. Bootstrap
emails become admin.
