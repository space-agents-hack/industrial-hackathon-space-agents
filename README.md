# Industrial agent template

A starting point for an agent that does real work in company systems: it reads a task, calls the
systems through tools, **stops and asks a person before any step that writes**, and records
everything it did. It comes with the web UI to watch and approve, the database, the tests and a
deploy pipeline that several people can push to without breaking production.

It runs out of the box with no API key, using a scripted model that plays the example task
(triaging an engineering change notice against mock PLM, CAD and ERP systems).

## Run it locally

Needs `uv`, Node 24+ and the Supabase CLI. Docker is only for the local database; production does
not use it.

```bash
make setup    # local database in Docker, no accounts needed
make dev      # http://localhost:3000, sign in with the demo user that setup printed
```

No Docker: use the hosted database instead. The Supabase project must exist and `supabase login`
must be done. Runs you start locally are then visible to everyone with an account.

```bash
make setup DB=hosted PROJECT_REF=<project reference>
```

Start the example run: it stops at "put the notice on hold" and waits for you to approve or deny.
The Setup page (http://localhost:3000/setup) lists the steps to production and checks the ones it
can. To use a real model, set `AGENT_MODEL` and its API key in `agent/.env`.

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
