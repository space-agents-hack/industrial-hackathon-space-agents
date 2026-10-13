# ADR-0001: Python agent service plus Next.js web, with the database as the contract

**Status:** Accepted
**Date:** 2026-10-13
**Deciders:** Clemente (Ramón informed)

## Context

This template has to work for a 27-hour hackathon with 2 to 4 people pushing to `main`, and
afterwards for personal projects. The two reference repos, hector and sereno, are entirely
TypeScript. The request for this template adds three things they do not have: `uv`, a
model-agnostic agent, and an "industrial" domain.

Two questions were bundled into "which language":

1. What language is the **agent and its tools** written in?
2. What language is the **web UI** written in?

In hector and sereno the answer to both was TypeScript because the agent work there is prompt
assembly and deterministic rules that live inside the web app. Nothing in them does numeric or
engineering work. That is why TypeScript was enough, and it is not evidence about question 1 here.

Forces:

- The only concrete hint the organisers give is an agent that reads a task, calls company systems
  (PLM, CAD, ERP), asks a person before the risky step and writes the result back.
- Industrial challenge material is likely to be tabular exports, time series, geometry, PDFs and
  vendor SDKs. The libraries for that work (numpy, pandas, scipy, pymupdf, CAD and optimisation
  packages) are Python. This is an inference from the domain, not a published fact about the tracks.
- The demo is judged live. The trace of what the agent did and the approval step are the demo, so
  the UI has to be good and has to update while the agent runs.
- The team's proven deploy pipeline is TypeScript on Vercel. Every extra toolchain is another way
  for `main` to go red at 3 a.m.

## Decision

Two units in one repo:

- `agent/`: Python 3.13, managed with `uv`, a FastAPI service that runs the agent loop and tools.
- `web/`: Next.js (TypeScript) for login, starting runs, the live trace and approvals.

They share **no code and no types**. The contract between them is the Postgres schema in
`supabase/migrations/`: the agent writes runs, events and approval requests as rows; the web reads
them (live, through Supabase Realtime) and writes approval decisions. The only direct call is one
authenticated HTTP request from the web server to the agent: "advance this run".

## Options Considered

### Option A: Python agent + Next.js web (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: two toolchains, two deploy units |
| Cost | Same hosting as today; one extra Vercel project |
| Scalability | Agent can move to a container without touching the web |
| Team familiarity | Web and pipeline familiar; Python service new |

**Pros:** right ecosystem for engineering data and vendor SDKs; best UI for the demo; a run
survives a crashed function because its state is rows, not memory; `uv` as requested.
**Cons:** two sets of checks in CI; a seam that must stay narrow; Python on Vercel has limits
(see ADR-0003).

### Option B: All Python (FastAPI with a server-rendered UI)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one language, one deploy unit |
| Cost | Lowest |
| Scalability | Fine |
| Team familiarity | Low on the UI side |

**Pros:** simplest pipeline. **Cons:** the live trace and approval screen become the weakest part
of the product, and they are the part the jury looks at.

### Option C: All TypeScript (as hector and sereno)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: one language, pipelines transfer nearly verbatim |
| Cost | Lowest |
| Scalability | Fine |
| Team familiarity | Highest |

**Pros:** nothing new to learn; one deploy; the Vercel AI SDK is model-agnostic too.
**Cons:** drops `uv`; if a challenge needs engineering computation or a Python-only SDK, the team
adds a Python service under time pressure with no pipeline for it.

## Trade-off Analysis

C is the cheapest to run and the one the team already knows. It loses on one scenario: a challenge
that needs Python. Adding a second language at hour 3 of 27, with no CI and no deploy path for it,
costs more than carrying that path from the start. A carries it from the start and pays for it with
a second set of checks on every push.

The risk in A is the seam. Making the database the contract keeps it to one HTTP call and a schema,
and gives the pause for human approval for free: an approval is a row, and resuming is a new
request that loads the saved conversation.

If a challenge turns out to need no Python at all, A still works: the agent service is simply thin.

## Consequences

- Easier: engineering and data tools; swapping the model provider (ADR-0002); recovering a run
  after a crash; replaying a run for the jury from its event rows.
- Harder: CI runs Python, TypeScript and SQL checks; a schema change is a change to both sides and
  must be backward compatible for one deploy (migrations go out before code).
- Revisit if: the Python checks routinely add more than about three minutes to a push, or two
  hackathon drills in a row use no Python-only capability.

## Action Items

1. [x] Record the agent library choice (ADR-0002) and the deploy topology (ADR-0003).
2. [ ] Run one timed drill from `gh repo create --template` to a deployed run with an approval.
3. [ ] After the drill, decide whether the two-toolchain cost was worth it and update this ADR.
