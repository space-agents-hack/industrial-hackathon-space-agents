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
- What the product must do and for whom: `docs/se/` (stakeholders, requirements, interfaces,
  verification). Who is doing what: **GitHub Issues**, nowhere else.

## Working in parallel

Two people (Clemente, Ramón) and several agents push to this repo at once. These rules exist so
that nobody builds on a guess about someone else's work.

- **Trunk-based: no branches, no pull requests.** Commit straight to `main` in small commits,
  after `git pull --rebase` and green checks (Clemente, 2026-10-24: under 24 hours left, a branch
  is a merge waiting to go wrong). Close an issue with `Fixes #n` in the commit message.
- **Issues are the only task tracker.** No task lists in `TODO.md` or in documents: a second copy
  drifts from the first.
- **Claim before you edit.** Pick an open issue without the `doing` label, add `doing`, and
  comment one line with your plan. Humans also assign themselves; agents add the label
  `owner:<agent-name>`, because several agents may commit through one account. If an issue has
  `doing` and is not yours, do not touch its files: pick another or ask on the issue.
- **Status labels:** `doing`, `blocked` (say on what). Closed means on `main`.
- **Every issue body has two lines:** `Traces to: SYS-x` (from `docs/se/requirements.md`) and
  `Interfaces: IF-x` (from `docs/se/interfaces.md`), or `none` with the reason. Work that serves
  no requirement either reveals a missing need (add it, say who it comes from) or is scope creep.
- **Commits mention the SYS- or IF- id** they implement or change.
- **Interfaces change only with both owners' agreement**, written on the issue, before merge. If
  you need a change on the other side, ask there; do not edit the other side's code to fit yours.
- **Owners are assigned by Clemente or Ramón.** Where a document or issue says `UNASSIGNED`, leave
  it and say so. Never write someone's name as owner on their behalf.
- **Issues opened by an agent are drafts** until Clemente or Ramón confirms them. Say so when you
  rely on one.
- **Notes others need** (a number you measured, a gotcha, an interface detail) go as a comment on
  the issue; if they outlive the task, into `docs/se/interfaces.md` or the score log in
  `docs/se/verification.md`.
- **Never `R-` or `R1` for our own ids.** Certivity's output requirements are `R-001...` and the
  brief's required elements are referred to as `CR1` to `CR4` (`docs/se/README.md`).

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
  Certivity's answer keys that the checks read (every `expected.json` and `requirements_old.json`)
  live in the database, table `certivity_reference` (Clemente, 2026-10-24), reloaded from their
  package on every release (`.github/workflows/deploy.yml`) or by hand with `make certivity-load`.
  The regulation list (`index.json`) is imported once into the organisation's regulation library,
  and the checks read it from there (ADR-0006): there is no second copy. Only Certivity's MIT code is in
  `agent/certivity/`; a test fails if any of their data appears there.
- **Case and regulation data live in Supabase, per organisation, never in the repo** (Clemente,
  2026-10-24; SYS-16, SYS-24). The files go to the private buckets (`case-files`, `regulations`);
  what is read from them (case content, regulation paragraphs) goes to tables with an
  `organization_id`. A fixture in a test is made up in the test.
- **Markdown under `agent/` is code.** The agent reads `domain/prompt.md` at run time, so a prompt
  change runs the checks and is released like any other change (`.github/workflows/deploy.yml`).
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
