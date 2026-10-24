# Working contract

Read `SOUL.md` in full before planning or editing. Keep other people's changes: check
`git status` first, and do not restore, reorder or mix in work that does not belong to the task.

This file is for whoever **builds** this repo. What the agent itself reads at run time is
`agent/agent_service/domain/prompt.md`. Do not confuse the two.

## Structure and sources of truth

- `agent/`: Python 3.13 with `uv`. The agent loop, the tools and the HTTP service.
  - `agent_service/domain/` is what the agent is *for*: prompt, tools, the systems it calls, the
    scripted model. Pointing the template at a new problem means editing this folder only.
  - `agent_service/runner.py` is the loop: start, pause for approval, resume. `store.py` is its
    only door to the database.
- `web/`: Next.js. Sign-in, starting runs, the live trace, approvals. It never calls a model, never
  holds the Supabase secret key, and has its own `web/AGENTS.md` about the Next.js version.
- `supabase/`: migrations, RLS policies and their pgTAP tests. **This schema is the contract
  between `agent/` and `web/`.** They share no code; they share these tables.
- `.github/workflows/deploy.yml` and `Makefile`: what runs on a push and what you run locally.
  They must stay in step.
- Living documents: the map in `docs/architecture.md`, the reasons in `docs/adr/`, tests in
  `docs/testing.md`, the pipeline in `docs/deploy.md`, the event playbook in `docs/hackathon.md`.
  Open work goes in `TODO.md`.

## Validation

Run `make check` before every push. It runs, in this order:

- agent: `ruff check`, `ruff format --check`, `pyright`, `pytest`, the evals with the scripted model
- web: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
- database: pending migrations applied locally, `supabase test db`, `supabase db lint`, and the
  agent's contract test against the local stack

The database part needs Docker. Without it `make check` prints SKIPPED for that part and still
exits green: say then that SQL and RLS were not tested against real PostgreSQL on this machine,
and that CI will run them. After changing the schema run `make types`. After
changing the prompt, a tool description or the model, run `make eval` with the real model and
report the result. Finish with `git diff --check` and read the diff for secrets.

## Limits

- **No secrets and no plausible-looking example credentials** in the repo. Values go in `.env`
  files (ignored) and in Vercel or GitHub settings.
- **Nothing from `data/` is committed**, quoted in a document, or pasted into a prompt file.
  Challenge and client material is confidential and has to be deletable
  (`scripts/purge-challenge-data.sh`).
  One exception, decided by Clemente on 2026-10-24 because the repository is private: the files
  Certivity's checks read (`regulations/index.json`, every `expected.json` and
  `requirements_old.json`) are committed in `agent/certivity/`, copied by
  `scripts/sync-certivity.sh`. Nothing else from the package goes there, and they are deleted
  after the event like the rest.
- **A tool that writes to a system of record is marked `requires_approval=True`** and has a test
  showing the run pauses before it. No exceptions for "small" writes.
- **Migrations are additive and never edited once on `main`.** They are applied before the code is
  deployed, so each one has to work with the version of the code that is already running.
- **Push to `main` in small commits**, after `git pull --rebase` and a green `make check`. If
  `main` is red, fixing or reverting it comes before any new work (`docs/deploy.md`).
- **Do not create cloud resources, rotate keys or change project settings** (GitHub, Vercel,
  Supabase) without being asked. Give the command and let a person run it.
- Give the reason for each decision, run the checks that apply, and always separate what you
  verified from what you assumed.
