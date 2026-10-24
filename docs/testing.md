# Testing

One rule decides where a test goes: **what is deterministic is tested; what a model decides is
evaluated.** A unit test that asserts on a real model's wording fails at random and teaches
everyone to ignore red. So the numbers and the rules live in plain Python and SQL where they can be
tested exactly, and the model's behaviour is measured separately, on purpose, when it changes.

`make check` runs everything in this table except a real-model eval and the smoke tests, which
run only in a release. CI runs the same.

## What exists

| Layer | Where | What it catches |
|---|---|---|
| Domain logic | `agent/tests/test_systems.py` | A wrong number: the fit rule, the minimum clearance, an unknown id answered with an empty list |
| Case ingestion | `agent/tests/test_ingest.py` | A format read wrongly (page labels, CAD structure), a file dropped without a trace note, a limit applied silently. Fixtures are built in the test, never challenge data |
| Certivity checks | `agent/tests/test_certivity.py` | A copy of `validate.py` that drifted from Certivity's (hash test); their data committed to the repo again; a score stored next to a file it was not computed on (`run_checks`, #51) |
| Regulation library | `agent/tests/test_regulations.py`, `test_regdiff.py` | An index file read wrongly, a PDF stored without its checksum, a sub-goal diff that misses a change |
| Agent loop | `agent/tests/test_runner.py` | A risky tool that runs without approval; a denied tool that runs anyway; a tool logged twice; a run that never ends |
| HTTP | `agent/tests/test_api.py` | An endpoint that is open when the secret is unset; wrong status codes |
| Contract | `agent/tests/test_store_integration.py` | A migration the agent can no longer read or write through |
| Access rules | `supabase/tests/*.sql` (pgTAP) | A browser that can edit a run, read the saved conversation, or change a decision |
| Web helpers | `web/lib/*.test.ts` | Events paired wrongly in the trace; the setup guard letting another site or machine in; form values the bootstrap script does not read (`contract.test.ts`) |
| Repository | `scripts/check-migrations.sh`, shellcheck, actionlint | An edited or out-of-order migration; a shell or workflow mistake |
| Evals | `agent/evals/` | A model that skips a check or does not ask before the risky step |
| Smoke | `.github/workflows/deploy.yml` | A build that compiles but does not start; a site that is public when signed out; a web that cannot reach the agent or a secret that differs (`/api/health/deep`) |
| Watchdog | `.github/workflows/watchdog.yml` | Production breaking between releases (an expired key, a paused database) |

The loop tests use the **scripted model** (`agent/agent_service/domain/scripted.py`): a fixed
policy that reads real tool results and decides from them. It makes the pause-and-resume path run
in milliseconds with no network. It says nothing about how a real model behaves; that is what the
evals are for.

## When you change something

- **A new tool that only reads.** Put the logic in `systems.py` and test it there. Add a line to
  the scripted model only if the example task should use it.
- **A new tool that writes.** Mark it `requires_approval=True`, and add a test in `test_runner.py`
  that the run pauses before it and that a denial leaves the system untouched. This is the test
  that matters most in the repo.
- **A migration.** Add or extend a pgTAP file for every policy you touch, run `make types`, and run
  `make check-db`. The contract test tells you whether the agent still agrees with the schema.
- **The prompt, the tools' descriptions, or the model.** Run `make eval` with the real model
  before and after. Add an eval case for any behaviour you corrected, so it stays corrected.

## Evals

`make eval` runs `agent/evals/requirements_writer.py` with whatever `AGENT_MODEL` is set, through
the real runner on an in-memory store: a made-up rear-lamp case and a made-up library of two
regulations (one applies, one does not). It checks that the regulation that applies is read and the
other is not, that every obligation that applies is cited, that the export waits for approval, and
that the file passes `validate.py`. With a real model it also checks that the obligation of another
device (the front position lamp) is left out; the scripted model cannot judge that. With `scripted`
it is free and proves the harness works (CI does this). The checks read what was stored and
called, so pass or fail does not depend on a second model's opinion. The quality measure on real
data is still the Certivity score (`score_local.py` on `dev-rear-lamp`, #14).

There is no coverage percentage to hit. The two rules that are checked in review instead:

1. Every tool that writes has a test proving the run pauses before it.
2. Every RLS policy has a pgTAP test for what it allows and what it refuses.

## What is not tested

- **The web in a browser.** No test signs in, starts a run and clicks Approve. The pieces on each
  side of that click are tested; the click is not. Do it by hand after changing the run page.
- **Realtime delivery.** Nothing checks that an inserted event reaches an open page.
- **Real providers in CI.** No test calls Anthropic, OpenAI, OpenRouter or DeepSeek. A provider
  that rejects a tool schema shows up in `make eval` with that provider, not in CI.
- **Platform limits.** The 770 s run timeout is tested with a zero timeout, not by running for
  770 s on Vercel.
- **Load.** Nothing runs two runs at once on purpose, apart from the test that a run is claimed
  only once.
