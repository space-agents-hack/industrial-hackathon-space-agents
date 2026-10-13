# web

The Next.js app of the template: sign in, start a run, watch what the agent does while it does it,
approve or deny the risky step, read the result.

It shares no code with `agent/`. The contract between the two is the Postgres schema in
`../supabase/migrations/` plus one HTTP call (see [Talking to the agent](#talking-to-the-agent)).
The reasons are in `../docs/adr/0001-stack-shape.md` and `../docs/adr/0003-deploy-topology.md`.

## Run it

Needs Node 24 or newer and the local Supabase stack.

From the repo root, `make setup` installs everything, starts the database, writes `web/.env.local`
and creates the demo user; `make dev` then starts the agent and the web together. To run only the
web by hand:

```bash
cd web
npm install
cp .env.example .env.local      # then fill it in, see below
npm run dev                     # http://localhost:3000
```

Sign-ups are off. Create a user with `make user EMAIL=you@example.test` from the repo root (see
`../supabase/README.md`) and sign in with it.

Without the agent service running, everything still works except the runs themselves: a new run is
saved as `queued` and its page says the agent could not be reached and offers **Retry**.

## Environment variables

| Variable | Where it is read | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser and server | Supabase API URL. Local: `API_URL` from `supabase status -o env`. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser and server | Publishable key (`sb_publishable_...`). Local: `PUBLISHABLE_KEY` from `supabase status -o env`. |
| `AGENT_URL` | server only | Base URL of the agent service. Local: `http://127.0.0.1:8000`. |
| `AGENT_SHARED_SECRET` | server only | Bearer token the agent expects. Must match the agent's own setting. |

`.env.local` is ignored by git. `.env.example` is the only env file that is committed.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` / `npm run start` | Production build and server. |
| `npm run lint` | ESLint, failing on any warning. |
| `npm run typecheck` | `next typegen && tsc --noEmit`. The first half generates the route types (`PageProps`, `RouteContext`) that the second half needs, so it works on a fresh checkout. |
| `npm test` | Unit tests with Node's own runner (`node --test`), no test framework. Node runs the `.ts` files directly. |

After a migration, regenerate the database types with `make types` from the repo root
(`supabase gen types typescript --local > web/lib/database.types.ts`).

## Routes

| Route | Auth | What it does |
| --- | --- | --- |
| `/login` | public | Email and password sign-in. |
| `/` | session | "New run" form and the list of runs, newest first, updated live. |
| `/runs/[id]` | session | The live trace: task, status, events, pending approvals, result, error, model and usage. |
| `GET /api/health` | public | `{ "status": "ok" }`. Used by the deploy smoke test; does not touch Supabase. |
| `POST /api/runs` | session | Body `{ task }`. Inserts the run as the user, asks the agent to start it, returns `{ id }`, plus `warning` when the run was saved but the agent call failed. |
| `POST /api/runs/[id]/advance` | session | Retry: asks the agent to pick the run up again. Passes the agent's `404` and `409` through; `502` when it cannot be reached. |
| `POST /api/approvals/[id]` | session | Body `{ decision: "approved" \| "denied", note? }`. Updates the approval as the user (`409` if it was already decided), then resumes the run once nothing is pending. |

`proxy.ts` (what Next.js called `middleware.ts` before version 16) refreshes the Supabase session on
every request and sends signed-out visitors to `/login`. Signed-out calls to `/api/*` get a `401`
JSON response instead of a redirect.

## Where things are

```
proxy.ts                    session refresh and the signed-in gate
app/(app)/                  the pages that need a session (header + Sign out)
app/login/                  the sign-in page
app/api/                    the four route handlers
components/                 run list, live trace, approval card, timeline
components/ui/              shadcn/ui components (owned code: edit them freely)
lib/config.ts               APP_NAME, the one place to rename the product
lib/trace.ts                event payload types and every pure helper; unit-tested
lib/validation.ts           request-body checks; unit-tested
lib/agent.ts                the one HTTP call to the agent
lib/runs.ts                 the database reads, shared by server and browser
lib/supabase/               browser client, server client, proxy helper
lib/database.types.ts       generated, do not edit
```

## Talking to the agent

`lib/agent.ts` sends `POST {AGENT_URL}/runs/{id}/advance` with the shared secret. The agent does the
whole run inside that request and writes its progress to the database; the response body is only
`accepted`, heartbeats and `done`. The web sends its own response as soon as the agent has accepted
and then keeps reading the agent's stream in the background with `after()`, because nothing
documented lets a Python function on Vercel keep working after its caller disconnects.

That is why the three handlers that call the agent export `maxDuration = 300` (the Hobby ceiling;
Pro allows 800): a run can last at most as long as the web function that holds its connection.

The browser never calls the agent, and never needs the response of that call: it reads `runs`,
`run_events` and `approvals` and subscribes to them through Supabase Realtime.

## Things to know before changing it

- **Cache Components is on** (`next.config.ts`, the `create-next-app` default). Each page has a
  static shell and streams the rest. Anything that reads the session or the database must sit
  inside a `<Suspense>` boundary, or the build fails. `createClient()` in `lib/supabase/server.ts`
  already waits for a real request, so the practical rule is: fetch in an async component and wrap
  it in `<Suspense>`, as `app/(app)/page.tsx` does.
- **Live updates.** Each live component subscribes, then reads once more, so nothing written
  between the server render and the subscription is missed. Rows are merged by primary key. A
  Realtime message that arrives without its large columns triggers a re-read instead of being used.
- **Unknown data does not break the page.** A status or event kind this build has never seen is
  shown as plain text with its JSON.
- **Light theme only.** The tokens are in `app/globals.css`; the status colours are in
  `components/status-badge.tsx`.

## What this app does NOT do

- **No sign-up, no magic link, no password reset.** Users are created by an administrator.
- **It never uses the Supabase secret key.** Every read and write goes through the signed-in
  user's session, so the RLS policies in the migration are what protects the data.
- **It never calls a model provider.** The agent service does; the web only asks it to advance.
- **No per-user or per-team separation.** Every signed-in user sees and can approve every run.
  That fits a team of two to four on one problem and nothing larger.
- **It does not write events, statuses, results or approval requests.** The agent does. The web
  inserts a run and decides an approval, nothing else.
- **No cancel, delete or edit of a run.** The schema grants the web no way to do it.
- **No Markdown rendering.** The task, the agent's text and the result are shown as plain text.
- **No dark mode, analytics, telemetry or i18n.**
