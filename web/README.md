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
| `/login` | public | Email and password sign-in. Signed-out visitors are sent here when deployed; on a developer's machine they are sent to `/setup` first. |
| `/` | session | The current organisation's runs, newest first, updated live, and the "New run" form (admins and members only). |
| `/runs/[id]` | session | The live trace: task, status, events, pending approvals, result, error, model and usage. Approve, Deny and Retry appear only for admins and members of the run's organisation. |
| `/admin` | org admin or platform admin | Models and limits: provider and model (from the agent's live list, with prices), model requests per run, monthly cost cap. Empty means the deployment default. |
| `/admin/providers` | org admin or platform admin | Anthropic, OpenAI, OpenRouter, DeepSeek: connected or not, last 4 characters, source, when, by whom. Paste (checked with the provider first), replace, remove; **Connect OpenRouter** (OAuth PKCE). |
| `/admin/people` | org admin or platform admin | People with role, status and last sign-in. Add a person (email, role, initial password shown once), change role, suspend or reactivate, set a new password where allowed. |
| `/admin/usage` | org admin or platform admin | Runs, tokens and recorded cost per month, against the cap. |
| `/admin/audit` | org admin or platform admin | The last 100 changes to settings, keys and people, as sentences. |
| `/admin/organizations` | platform admin | Every organisation; create one and add its first admin. |
| `/setup` | public locally, session when deployed | The steps to a local or a production environment (`?env=local` or `?env=production`), with the ones it can observe checked. Works with nothing configured. Never asks for a secret. |
| `GET /api/health` | public | `{ "status": "ok" }`. Used by the deploy smoke test; does not touch Supabase. |
| `POST /api/runs` | admin, member | Body `{ task, organization_id }`. Inserts the run as the user (`403` if RLS refuses: viewer, suspended, or not a member), asks the agent to start it, returns `{ id }`, plus `warning` when the run was saved but the agent call failed. |
| `POST /api/runs/[id]/advance` | admin, member | Retry: asks the agent to pick the run up again. `403` for a viewer. Passes the agent's `404` and `409` through; `502` when it cannot be reached. |
| `POST /api/approvals/[id]` | admin, member | Body `{ decision: "approved" \| "denied", note? }`. Updates the approval as the user (`403` for a viewer, `409` if it was already decided), then resumes the run once nothing is pending. |
| `POST /api/admin/settings` | org admin | Body `{ org, model, max_model_requests, monthly_cost_cap_usd }`; empty or null stores null. A changed model must be in the provider's current list. |
| `GET /api/admin/models` | org admin | `?org=&provider=`. The agent's `GET /providers/models`; `409` when a direct provider has no key. |
| `POST`, `DELETE /api/admin/providers` | org admin | Paste or replace a key (`{ org, provider, api_key }`, checked with `POST /providers/check` first), or remove one (`{ org, provider }`). |
| `GET /api/admin/providers/openrouter/start` | org admin | `?org=`. Sets a 10-minute httpOnly PKCE cookie scoped to the callback and redirects to openrouter.ai. |
| `GET /api/admin/providers/openrouter/callback` | org admin | Checks cookie and state, exchanges the code for a key server to server, stores it, redirects to Providers with a result code. |
| `POST`, `PATCH /api/admin/people` | org admin | Add a person (`{ org, email, role, password }`: agent `POST /admin/users`, then `set_member`), or change role and status (`{ org, user_id, role, status }`). |
| `POST /api/admin/people/password` | org admin | `{ org, user_id, password }`. Only when `can_reset_password` says so; then agent `POST /admin/users/password`. |
| `POST /api/admin/organizations` | platform admin | `{ name }` → `{ id }` through `create_organization`. |

`proxy.ts` (what Next.js called `middleware.ts` before version 16) refreshes the Supabase session on
every request and sends signed-out visitors to `/login`. Signed-out calls to `/api/*` get a `401`
JSON response instead of a redirect.

## Organisations and roles

The model is in `../supabase/migrations/20261014120000_platform.sql` and the reasons in
`../docs/adr/0004-platform-layer.md`.

| Role | May |
| --- | --- |
| platform admin | See and manage every organisation, create organisations. Starts runs only where also a member. |
| admin | Manage one organisation's people, settings and keys; start runs; decide approvals. |
| member | Start runs and decide approvals. |
| viewer | Read runs. |

- **The current organisation** comes from the `org` cookie, honoured only for an organisation the
  person may see (`my_access()`, read once per request in `lib/current-org.ts`); otherwise the first
  one. The header shows a switcher only when there is more than one.
- **Someone in no active organisation** (and not a platform admin) sees a page saying they have no
  access yet. Each page decides this inside its own Suspense boundary, not the layout: a layout that
  waits for the request before rendering its children drops every page out of the static shell.
- **Hiding is courtesy, not protection.** `lib/access.ts` decides what to offer; every admin route
  asks the database for the caller's role again (`lib/admin-route.ts`) before calling the agent, and
  every write goes through a database function that checks the role and writes the audit row
  itself. The web never inserts audit rows.

## Where things are

```
proxy.ts                    session refresh and the signed-in gate
app/(app)/                  the pages that need a session (header + Sign out)
app/login/                  the sign-in page
app/(app)/admin/            the admin tabs, one route each
app/api/                    the route handlers; app/api/admin/ for the admin area
components/                 run list, live trace, approval card, timeline, org switcher
components/admin/           the admin area's interactive parts
components/ui/              shadcn/ui components (owned code: edit them freely)
lib/config.ts               APP_NAME, the one place to rename the product
lib/trace.ts                event payload types and every pure helper; unit-tested
lib/validation.ts           request-body checks; unit-tested
lib/agent.ts                the call that advances a run
lib/agent-admin.ts          the agent's admin calls: users, passwords, key checks, model lists, health
lib/access.ts               roles → what to offer; unit-tested
lib/current-org.ts          my_access() once per request, the current organisation
lib/admin.ts                providers, models, prices, admin request bodies, audit sentences; unit-tested
lib/pkce.ts                 PKCE verifier and S256 challenge; tested against RFC 7636
lib/runs.ts                 the database reads, shared by server and browser
lib/supabase/               browser client, server client, proxy helper
lib/database.types.ts       generated, do not edit
```

## Talking to the agent

`lib/agent-admin.ts` makes the admin area's calls (`POST /admin/users`, `POST /admin/users/password`,
`POST /providers/check`, `GET /providers/models`, `GET /health`), each with the shared secret and a
15-second timeout, and turns failures into sentences. The agent holds the Supabase secret key and
the provider keys; that is why creating a person or testing a key goes through it.

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

- **No sign-up, no magic link, no self-service password reset.** People are added by an admin in
  Admin, People, who chooses the initial password and hands it over.
- **No email of any kind.** Adding a person or setting a password shows the password once on the
  admin's screen; nothing is sent.
- **No billing, plans or payments.** Usage shows the cost the agent recorded per run; it is not an
  invoice, and the provider's bill is the one that counts.
- **No "sign in with Claude" or "sign in with ChatGPT".** Anthropic does not allow third-party apps
  to use Claude.ai plan logins, and OpenAI's ChatGPT sign-in for hosted apps is partner-only.
  Connect OpenRouter instead: one key, billed to the OpenRouter account that approved it.
- **No deleting or renaming organisations, no removing people** (suspend instead, which keeps
  their history), and no making platform admins from a page (`scripts/create-user.sh --platform-admin`).
- **Keys are never shown back.** After saving, only the provider, the last four characters, the
  source, when and by whom.
- **It never uses the Supabase secret key.** Every read and write goes through the signed-in
  user's session, so the RLS policies and the platform functions are what protect the data.
  Creating auth users and setting passwords is the agent's job, asked for over HTTP.
- **It never calls a model provider.** The agent service does; the web only asks it to advance.
- **It does not write events, statuses, results or approval requests.** The agent does. The web
  inserts a run, decides an approval, and calls the platform functions from the admin area.
- **No cancel, delete or edit of a run.** The schema grants the web no way to do it.
- **No Markdown rendering.** The task, the agent's text and the result are shown as plain text.
- **No dark mode, analytics, telemetry or i18n.**

## If the local page keeps reloading itself

The development server can lose track of its modules when something else rebuilds or installs
in `web/` while it runs (a `make check`, `npm ci`, switching branches). The page then retries a
failed render forever. Stop `make dev`, delete the development cache and start again:

```bash
rm -rf web/.next/dev && make dev
```
