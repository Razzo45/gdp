# Need a hand

Read-only classify-first help for the rubric holder. Same Next app, same Railway worker. Lowest-priority job kind `rubric_helper`. Does not reseat or write the rubric.

## When it runs

The holder must have a current rubric, at least one Golden grade, an AI pack grade (Stability passes), an AI file, and a Catalog brief. Catalog stores that brief on `task` more often than `prompt`.

The helper is available while the task is in the **rubric** stage.

## What a run does

1. **Classify** each seated row from Golden + this AI pack (Stability answers). Stability spread is not a score.
2. **Keep / Act / Add** — Keep discriminators and required locks; Act is override / reword / drop; Add is only a measured Golden Yes / AI No that is grounded in the brief or a named input.
3. **Mix** predicts Golden % (every seated row true on the human file) and calibration % (AI yes-rate on this pack). Ready only when predicted Golden is 100 and calibration is in 20–40. A breaking batch is refused.

Copy-only. The human pastes into the editor.

## Queue

`POST /api/submissions/:id/helper` enqueues. The shared worker claims `rubric_helper` last (after Golden reassess, other work, and factory). Model calls use the `idle` admission class so they wait behind interactive and background work.

Apply `drizzle/0010_rubric_helper.sql` on Railway Postgres before the first live run (`npm run db:migrate` against that `DATABASE_URL`).

## Local sandbox (optional)

`npm run dev:helper` and `npm run dev:helper-from` write a PGlite file outside the repo. They are not Railway. Do not point them at live Supabase.
