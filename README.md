# Industrial agent template

A starting point for an agent that does real work in company systems: it reads a task, calls the
systems through tools, **stops and asks a person before any step that writes**, and records
everything it did. It comes with the web UI to watch and approve, the database, the tests and a
deploy pipeline that several people can push to without breaking production.

It runs out of the box with no API key, using a scripted model that plays the example task
(triaging an engineering change notice against mock PLM, CAD and ERP systems).

## What you need

Docker has one job here: running a private copy of the database on your own machine. Production
never uses it, and you can work without it.

| To do this | You need |
|---|---|
| Run the app with its **own private database** on your machine | `uv`, Node 24+, the Supabase CLI and **Docker** |
| Run the app on your machine against the **hosted database** | `uv`, Node 24+ and the Supabase CLI. No Docker |
| Deploy | Nothing on your machine: pushing to `main` deploys |
| Connect a new repository to Vercel and Supabase, once | The `gh` and Vercel CLIs, for `scripts/bootstrap.sh` |
| Run the database tests before pushing | Docker. Without it they run in CI, which blocks the release if they fail |

Which to choose:

- **With Docker** you need no account at all, you work offline, and nothing you try is visible to
  anyone. It costs an install, a few gigabytes of images on the first start and some memory.
- **Without Docker** setup is shorter, but the runs you start locally are stored in the hosted
  database where everyone with an account sees them, you need a network connection, and a
  migration you want to try is applied to the real database.

## Run it locally

### With Docker (private database, no accounts)

```bash
make setup
```

```bash
make dev
```

Open http://localhost:3000 and sign in with the demo user that `make setup` printed. Start the
example run. It stops at "put the notice on hold" and waits for you to approve or deny.

### Without Docker (hosted database)

The Supabase project has to exist first (see "Start a project from it"), and your Supabase account
needs access to it. Sign in once with `supabase login`, then:

```bash
make setup DB=hosted PROJECT_REF=<project reference>
```

```bash
make dev
```

Sign in with your own account; the project owner creates it with `scripts/create-user.sh`.
`PROJECT_REF` can be left out on a machine where `scripts/bootstrap.sh` or `supabase link` has
already run.

### Either way

The **Setup** page in the app (http://localhost:3000/setup) lists the steps from here to a
production deployment, checks the ones it can, and says which database you are on.

To use a real model, edit `agent/.env`: set `AGENT_MODEL` (for example
`anthropic:claude-opus-5-5`, `openai:gpt-5.2`, `openrouter:...`, `deepseek:...`) and the matching
API key. Nothing else changes.

## Start a project from it

```bash
gh repo create my-project --private --template clemenjuan/industrial-agent-template --clone
```

```bash
cd my-project && make setup && scripts/bootstrap.sh
```

`bootstrap.sh` connects the new repository to its own Vercel and Supabase projects. After that,
every push to `main` is checked, deployed without the production domain, smoke-tested and only
then promoted (`docs/deploy.md`).

Then make it yours: everything about *what the agent is for* is in one folder,
`agent/agent_service/domain/`.

| File | Replace with |
|---|---|
| `systems.py` | Calls to the real systems or data |
| `tools.py` | The tools the model may call; mark every write `requires_approval=True` |
| `prompt.md` | How the agent should work and report |
| `scripted.py` | A scripted run of your task, or delete it and remove `scripted` from the settings |

## What is in the box

- `agent/`: Python 3.13 and `uv`, FastAPI, Pydantic AI. Model-agnostic: one environment variable
  picks the provider.
- `web/`: Next.js. Sign-in, new run, live trace, approve or deny.
- `supabase/`: the schema both sides share, row-level security, and tests for it.
- `.github/workflows/deploy.yml`: checks, migrations, deploy, smoke test, promote.
- `Makefile`: `make check` runs exactly what CI runs.
- `SOUL.md`, `AGENTS.md`, `CLAUDE.md`: how coding agents and people work in this repo.

## What it does not do

- Run longer than one serverless request per step (300 s on Vercel Hobby, 800 s on Pro).
- Separate users from each other: everyone with an account sees every run.
- Check *who* approved: the approval is a pause, not a permission system.
- Persist anything in the mock systems, which exist to be replaced.

The full list, with the reasons, is in `docs/architecture.md`.

## Documents

- `docs/architecture.md`: the map, a run step by step, how it fails.
- `docs/adr/`: why Python plus Next.js, why Pydantic AI, why two Vercel projects.
- `docs/testing.md`: what is tested, what is evaluated, what is not covered.
- `docs/deploy.md`: the pipeline, the secrets, rollback, what to do when `main` is red.
- `docs/hackathon.md`: the first hour, the rhythm, the freeze, the data rules.
- `supabase/README.md`: local database, changing the schema, the hosted project.
