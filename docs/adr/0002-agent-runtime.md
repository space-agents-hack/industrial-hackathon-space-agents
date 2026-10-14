# ADR-0002: Pydantic AI as the agent library, model chosen by one environment variable

**Status:** Accepted
**Date:** 2026-10-13
**Deciders:** Clemente (Ramón informed)

## Context

The agent must be model-agnostic: Claude at the hackathon (free credits), and OpenAI, OpenRouter
or DeepSeek in other projects. A run must be able to stop before a risky tool call, wait for a
person for minutes or hours, and continue in a different process. Functions on Vercel are
short-lived, so nothing can be held in memory between the pause and the resume.

Facts checked against the Pydantic AI docs on 2026-10-13 (v2.55.0, released 2026-10-09):

- A model is a string, `provider:model`, with prefixes `anthropic:`, `openai:`, `openrouter:` and
  `deepseek:`, each reading its own `*_API_KEY` variable. It can be passed per run.
- A tool marked `requires_approval=True` ends the run with a `DeferredToolRequests` output. The run
  resumes with `DeferredToolResults` in which each call is approved or denied.
- `result.conversation` serialises to JSON with `ConversationTypeAdapter` and carries the pending
  approvals, so it can be stored in a `jsonb` column and resumed elsewhere.
- `TestModel` and `FunctionModel` run the whole loop without calling a provider.
- The library releases about weekly and requires Python 3.11 or newer.

## Decision

Use `pydantic-ai-slim` with the provider extras we need. The model is read from `AGENT_MODEL`
(for example `anthropic:claude-opus-5-5`); changing provider is a change to that variable and the
matching API key, with no code change. `AGENT_MODEL=scripted` runs the loop with no key at all.

The conversation is saved to Postgres at every pause and at the end of every run. Approvals are
rows that the web UI resolves.

## Options Considered

### Option A: Pydantic AI (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to medium |
| Cost | Library is free; provider cost only |
| Scalability | Stateless between requests by design |
| Team familiarity | New |

**Pros:** approval and cross-process resume are built in and documented; typed tools; offline test
models; evals package from the same project.
**Cons:** fast release cadence, so the lockfile must be respected; v2 names differ from older
tutorials (`Conversation`, `result.usage` as an attribute).

### Option B: Provider SDK directly (Anthropic SDK and our own loop)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: we write the loop |
| Cost | Same |
| Scalability | Same |
| Team familiarity | Closest to hector and sereno |

**Pros:** nothing between us and the model; newest provider features first.
**Cons:** not model-agnostic, which is a stated requirement.

### Option C: LangGraph

| Dimension | Assessment |
|-----------|------------|
| Complexity | High: graph, checkpointer and its own persistence model |
| Cost | Same |
| Scalability | Good |
| Team familiarity | New |

**Pros:** mature interrupts and checkpointing. **Cons:** more concepts to debug during a 27-hour
build than the problem needs.

### Option D: A gateway only (LiteLLM or OpenRouter) with our own loop

**Pros:** thin. **Cons:** we would write approval, resume and test doubles ourselves.

## Trade-off Analysis

The requirement that decides it is pause, persist, resume in another process. A and C both provide
it; A does so with one JSON blob and no extra infrastructure. B fails the model-agnostic
requirement. D leaves the hardest part to us.

## Consequences

- Easier: switching provider; testing the loop in CI without spending tokens; adding MCP servers
  as tool sources later.
- Harder: upgrades need a deliberate `uv lock --upgrade-package` and a test run, not a drift.
- What the approval step does **not** do: it is not an authorisation boundary. A tool that must
  never run without a named person's consent has to check that itself.
- Revisit if: we need steps that outlive one function invocation without a human in between; then
  look at the durable-execution integrations.

## Action Items

1. [x] Pin the version in `uv.lock`; CI installs with `--locked`.
2. [x] Test the pause and resume path with a scripted model in `agent/tests/` (`test_runner.py`).
3. [ ] Run the example task once against each provider we intend to use and note differences.
