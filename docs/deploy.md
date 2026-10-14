# Deploy

Pushing to `main` is the deploy. There is no other way to production: Git-triggered deploys are
off in both Vercel projects, so the only path is `.github/workflows/deploy.yml`.

## What a push does

1. **Checks**, in parallel: Python (`agent/`), web (`web/`), database (`supabase/`).
2. If all three are green, **release**, one at a time:
   1. Skip if `main` has already moved past this commit.
   2. Apply new migrations to the hosted database.
   3. Deploy the agent **without** the production domain, smoke-test it, promote it.
   4. Build and deploy the web **without** the production domain, then smoke-test it, including
      `/api/health/deep`, which checks the web reaches the agent with the shared secret and the
      agent reaches the database.
   5. Promote the web.

To follow a release job by job and step by step, with the reason when one fails: the Setup page
under `make dev` (read with your `gh` sign-in), or **Admin › Releases** in production for platform
admins. Production needs the optional `RELEASES_GITHUB_TOKEN` below; the page links to GitHub's
form, filled in.

A scheduled workflow (`watchdog.yml`) runs the same deep check against production every 30
minutes and keeps a GitHub issue open while it fails.

A failure at any step stops there. Production keeps serving the previous version, with two
exceptions: migrations already applied stay applied, and if the web's smoke test fails the agent
has already been promoted. Both must therefore work with the web that is live.

## One-time setup

The local Setup page (`make dev`, then "Deploy to production") does this from a form; it runs
`scripts/bootstrap.sh`, which also works on its own in a terminal. What it sets, so you can check
or do it by hand:

GitHub, environment `production`, secrets:

| Secret | What it is |
|---|---|
| `VERCEL_TOKEN` | A Vercel access token |
| `VERCEL_ORG_ID` | The Vercel team or user id |
| `VERCEL_WEB_PROJECT_ID` | The project that serves `web/` |
| `VERCEL_AGENT_PROJECT_ID` | The project that serves `agent/` |
| `SUPABASE_ACCESS_TOKEN` | A Supabase personal access token |
| `SUPABASE_PROJECT_REF` | The project reference (the subdomain of its URL) |
| `SUPABASE_DB_PASSWORD` | The database password |

GitHub repository variables: `VERCEL_AUTHOR_NAME`, `VERCEL_AUTHOR_EMAIL` (the Vercel owner's git
identity, so a teammate's push deploys).

Vercel, Production environment variables:

| Project | Variables |
|---|---|
| web | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `AGENT_URL`, `AGENT_SHARED_SECRET`; optional `RELEASES_GITHUB_TOKEN` (fine-grained, this repository only, Actions read-only) |
| agent | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AGENT_SHARED_SECRET`, `AGENT_MODEL`, and the API key of that model's provider |

Both `vercel.json` files pin the functions to `fra1` (Frankfurt). Keep that next to the database's
region: the agent writes a row per event, and each one is a round trip.

With none of the Vercel secrets set, the release job says so and stays green. With some of them
set, it fails and names the missing ones.

## Before you push

- [ ] `git pull --rebase` first. Someone else has probably pushed.
- [ ] `make check` is green locally. CI takes minutes; this takes seconds to tell you the same.
- [ ] If the commit has a migration: it works with the code that is in production **now**, not
      only with the code in this commit. Add columns as nullable or with a default; do not rename
      or drop anything the running code reads.
- [ ] If the commit adds an environment variable: it is already set in Vercel. A variable missing
      in production is found by the smoke test at best and by a user at worst.
- [ ] No file from `data/` and no secret in the diff (`git diff --cached`).

## After you push

- [ ] The run is green through "Promote web" (Admin › Releases says **Released**; "Not released"
      means the checks passed and nothing was deployed, with the reason).
- [ ] Open the production site, start the example run, approve the step. Two minutes, and it is
      the only check of the whole path with a real browser.

## When main is red

Production is not affected: a red check means nothing was released. What is affected is everyone
else, because their pushes will not release either.

1. The person whose commit turned it red says so to the team at once.
2. If the fix is not obvious within ten minutes, revert: `git revert <sha> && git push`. Fix it on
   your machine afterwards, with `make check`.
3. Nobody stacks new work on a red `main`. A second failure on top of the first is much harder to
   read.

If the **release** job is red but the checks are green, read which step failed:

| Step that failed | What it means | What to do |
|---|---|---|
| Apply migrations | The hosted database refused the SQL | Fix with a new migration. Nothing was deployed |
| Smoke agent, got 503 | A variable is missing in the agent's Vercel project | Set it, re-run the job |
| Smoke agent or web, other | The build does not start | Read the function logs in Vercel; production still serves the old version |
| Promote | Vercel refused the promotion | Re-run the job; if it repeats, promote from the Vercel dashboard |

## Rollback

Decide before the demo, not during it: **if the example run does not complete on production, roll
back first and investigate second.**

- Code: `vercel rollback` in `web/` or `agent/` (or "Instant Rollback" in the dashboard) puts the
  previous deployment back in seconds without rebuilding. The two projects roll back
  independently.
- Database: there is no rollback. A bad migration is fixed by a new migration. This is why
  migrations must stay compatible with the previous code.
- Then revert the commit on `main`, or the next push releases the same problem again.

## Migrations

They are applied by the workflow, after the checks and before the code. That differs from sereno,
where they are applied by hand from one laptop: with several people pushing through a weekend, one
laptop is a bottleneck. The price is that an applied migration cannot be taken back by the
workflow. Never edit a migration that has reached `main`; write a new one.

To apply by hand instead, leave the three Supabase secrets unset and follow `supabase/README.md`.

## Verified on a real deployment

First confirmed on 2026-10-14 with hackathon-prep (Vercel Pro, Supabase in Frankfurt):

- The setup form (and `scripts/bootstrap.sh` behind it) connects a fresh repository end to end.
- Migrations applied by the workflow; Vercel builds `agent/` from `uv.lock` as FastAPI on Python
  3.13; the web deploys prebuilt; both smoke tests pass; both are promoted.
- Production: the web redirects signed-out visitors to `/login`, the setup endpoints are closed,
  the agent answers `/health` and refuses a request without the shared secret.

Two things the first releases taught, now fixed: a project created by `vercel project add` has no
framework, so both `vercel.json` files declare it; and `vercel curl` hands unknown options such as
`--cwd` to curl, so the smoke steps run from each project's folder.

Still to confirm: a full run in production (sign in, start the example, approve), which is also
the test that the web holds its connection to the agent for the length of a run on Vercel.
