# ADR-0003: Two Vercel projects from one repo, deployed by one workflow

**Status:** Accepted
**Date:** 2026-10-13
**Deciders:** Clemente (Ramón informed)

## Context

ADR-0001 gives us a Next.js app and a FastAPI service in one repo. Both should deploy to Vercel
from GitHub Actions the way hector and sereno do: checks first, deploy without the domain, smoke
test, then promote. Several people push to `main`, so the pipeline must not break in ways nobody
on the team can diagnose.

Facts checked against the Vercel docs on 2026-10-13:

- Python functions support `pyproject.toml` with `uv.lock`, Python 3.12 to 3.14, a 500 MB bundle,
  and FastAPI with no configuration. A FastAPI app is one function.
- Maximum duration is 300 s on Hobby and 800 s on Pro.
- "Services" is the documented way to run a Next.js frontend and a FastAPI backend in one project.
  It is **Beta**. Its docs say "Middleware is not supported inside a service", and no page says
  whether `vercel build` plus `vercel deploy --prebuilt` works with it.
- No equivalent of `waitUntil` is documented for Python, so the agent cannot be assumed to keep
  working after it has sent its response.
- Python files in a root `/api` folder next to Next.js are described as support for existing
  projects, not as the way to start a new one.

## Decision

Two ordinary Vercel projects, `web/` and `agent/`, each deployed with the CLI from one workflow
using its own project id. Git-triggered deploys are off in both. The web server calls the agent at
`AGENT_URL` with a shared secret; the browser never calls the agent.

The run executes inside the agent's request. The web keeps that request open in the background
(`after()` in Next.js) so nothing depends on the agent surviving a closed connection.

The web is built in CI and deployed prebuilt, as in hector and sereno. The agent is built by
Vercel from source, so its compiled Python packages are built for the platform they run on.

## Options Considered

### Option A: Two projects (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: two project ids, two promote steps |
| Cost | Two projects on the same plan |
| Scalability | Each side scales and rolls back alone |
| Team familiarity | Each project is the same kind hector and sereno already use |

**Pros:** nothing in Beta; Next.js middleware works, which Supabase session refresh needs; either
side can be rolled back alone.
**Cons:** more secrets to set up; a preview of the web talks to the production agent.

### Option B: One project with Services

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low once it works |
| Cost | One project |
| Scalability | Same |
| Team familiarity | New, and Beta |

**Pros:** one deployment, one domain, previews of both sides together.
**Cons:** Beta; no middleware inside a service; prebuilt deploys unconfirmed. A failure here during
the hackathon would be one we cannot debug from experience.

### Option C: Agent on a container host (Fly, Cloud Run, Railway)

**Pros:** no duration or bundle limit. **Cons:** a second platform, account and pipeline. Kept as
the escape hatch: `agent/` is a plain ASGI app, so it can be moved without touching the web.

## Trade-off Analysis

B is the better design on paper and the one Vercel recommends. A is the one where every piece is
something that already works in production for this team. For a pipeline whose job is not to break
in 27 hours, the known pieces win. The cost is a longer one-time setup, which a bootstrap script
absorbs.

## Consequences

- Easier: debugging a failed deploy; rolling back one side.
- Harder: first-time setup; database, agent and web go out in that order, so a schema change has
  to work with the previous version of the code for one deploy.
- A run is limited by the function duration (300 s on Hobby, 800 s on Pro). A run that needs
  longer has to be split at an approval or moved to Option C.
- Revisit if: Services leaves Beta and documents prebuilt deploys and middleware.

## Action Items

1. [x] Confirm the agent builds from source and answers `/health` (first release, 2026-10-14).
   It needed `"framework": "fastapi"` in `agent/vercel.json`.
2. [ ] Measure how long a run can take before the platform ends it, on the plan in use.
3. [x] One-command setup: `scripts/bootstrap.sh`, also driven by the Setup page.
