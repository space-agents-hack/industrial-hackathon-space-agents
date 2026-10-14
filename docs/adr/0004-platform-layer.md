# ADR-0004: A platform layer every project starts with

**Status:** Accepted (2026-10-14: organisations as the client model; all eight parts)
**Date:** 2026-10-14
**Deciders:** Clemente

## Context

The template runs an agent end to end, but everything about the running product is fixed at
deploy time: the model, the API keys, who can sign in. Changing any of it means editing Vercel
variables and redeploying, which is exactly what hector and sereno each had to stop doing after
it hurt (hector `lib/config-runtime.ts`, sereno `assistant_settings`).

An inventory of both apps (2026-10-14) found these pieces in both, or built in one after an
incident: settings editable in production with defaults in the repo; a live model catalogue;
cost logged per call and caps checked before spending; roles checked on the server; an admin
panel (users, invitations, models, usage); one code path for invitations; a scheduled watchdog;
a sandbox for admins; and, in sereno, a secrets store with separate writer and reader.

Facts checked on 2026-10-14 that bound the design:

- **"Sign in with your Claude account" is prohibited** for third-party apps: Anthropic "does not
  permit third-party developers to offer Claude.ai login ... or to route requests through Free,
  Pro, or Max plan credentials" (code.claude.com/docs/en/legal-and-compliance). Hermes Agent does
  it by impersonating Claude Code; we do not copy that.
- **"Sign in with ChatGPT" for hosted apps is a partner waitlist** (developers.openai.com/siwc).
  The Codex login Hermes reuses only redirects to localhost.
- **OpenRouter's OAuth (PKCE) is built for this:** one click, and the app receives a key billed
  to the user's own OpenRouter account. One such key reaches Claude, GPT and most other models.
- **Supabase recommends Vault for secrets;** pgsodium is being deprecated.

## Decision

Add a platform layer to the template, in this order of value:

1. **Roles.** A *platform admin* (whoever operates the deployment) is a row in a private table
   that no API can write, as in sereno. Everyone else is a member of an organisation with role
   `admin`, `member` or `viewer`. Checked by RLS and by the server, never only in the page.
2. **Organisations (client view).** Runs, settings and keys belong to an organisation. A clone
   starts with one organisation and the UI does not show switching until there are two. Adding
   tenancy later means rewriting every policy, which is why it is in from the start.
3. **Settings page** (`/admin`): model per organisation from a live catalogue (OpenRouter's list,
   with prices; an invalid choice cannot be saved), limits (requests per run, monthly cost cap),
   with the repo's values as defaults and only changes stored.
4. **Provider connections:** "Connect OpenRouter" (one click), or paste a key for Anthropic,
   OpenAI, OpenRouter or DeepSeek. Stored in Supabase Vault through functions only a platform
   admin can call; the browser sees provider, last 4 characters, who added it and when; the agent
   reads the key at run time. Test before save (one cheap call), rotate, delete.
5. **People:** invite by email, change role, suspend. One code path, replacing the script.
6. **Usage:** cost per run is already recorded; show it per organisation and month, and refuse a
   new run past the cap with the reason.
7. **Audit log:** append-only rows for every change to settings, keys and people.
8. **Watchdog:** a scheduled workflow that checks production (deep health: web reaches agent,
   agent reaches the database) and opens a GitHub issue when it fails.

## What this does not do

- No subscription logins (Claude or ChatGPT plans); see Context.
- No billing, plans or Stripe: product-specific, as in hector.
- No i18n, support tickets or announcements.
- No per-user API keys: keys belong to the organisation (or the platform), not to a person.

## Options considered for the riskiest choice: where keys live

| Option | Assessment |
|---|---|
| Vercel environment variables (today) | Simple; every change needs a redeploy and a person with Vercel access |
| Supabase Vault, written and read only through `security definer` functions (chosen) | Encrypted at rest with a key outside the database; no redeploy; the browser never reads a key back |
| App-level AES-GCM with a key in the server environment | Works anywhere; one more secret to rotate and keep in two services |

## Consequences

- Easier: changing model, key or people from the browser in production; showing a client only
  their organisation; knowing who changed what.
- Harder: every new table needs an organisation column and policies; tests grow accordingly.
- Revisit if OpenAI or Anthropic open a sanctioned "sign in" for hosted apps.

## Action Items

1. [x] Decisions confirmed by the owner on 2026-10-14.
2. [ ] Build 1–7 in the template, then `git pull template main` in each project.
3. [ ] Build 8 together with the deep health check from the tech-debt audit.
