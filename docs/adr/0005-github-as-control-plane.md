# ADR-0005: GitHub holds the deployment's credentials; production changes them through it

**Status:** Accepted
**Date:** 2026-10-15
**Deciders:** Clemente

## Context

Until now the deployment's credentials (Vercel token, Supabase token, database password, the
secret between web and agent) could only be set from a laptop: the local Setup page ran
`scripts/bootstrap.sh` with the gh, vercel and supabase CLIs. Every change meant going back to
that laptop, which the owner judged pointless. Production could already manage people, models and
provider keys (ADR-0004), but not the deployment itself.

Two decisions arrived together and are separate:

1. Where those credentials live once production exists, so that production can change them.
2. How a new project gets its first deployment, before there is a production to use.

The constraint: the Vercel token controls every project of the team, the Supabase token every
project of the account. Whatever the app holds, a stolen admin session or a bug can use.

## Decision

1. **GitHub is the control plane.** The credentials stay in the repository's `production`
   environment. Production holds the key of a **GitHub App made for this repository only**
   (`GH_APP_ID`, `GH_APP_PRIVATE_KEY_B64`), which mints one-hour tokens that can *write* a secret
   but never read one back, read the Deploy workflow's runs and start releases. Admin ›
   Deployment seals a new value to the environment's public key, stores it, and starts a release
   that copies it to Vercel first. Platform admins only, password typed again, audit row with the
   names of what changed.
2. **One setup path, from the local Setup page.** Connect GitHub (the app, by GitHub's manifest
   flow: Create, Install, nothing copied), paste the Vercel and Supabase tokens, press Create
   production. `scripts/bootstrap.sh` does the rest and releases.

## Options considered

| Option | Assessment |
|---|---|
| A. GitHub as control plane (chosen) | The app never holds the Vercel or Supabase tokens. Worst case of a stolen admin session: values overwritten and main redeployed; no token read, no code changed |
| B. The app holds every token in Vault, calls Vercel and Supabase directly | Simplest and fastest to use; one breach exposes every project in both accounts |
| C. Credentials stay on a laptop | Safest; the inconvenience the owner rejected |

## What this does not do

- The app has no Administration permission: with it, it could delete the repository. Setup
  creates the environment and the rule that only `main` may use it with your own `gh` instead.
- No read-back: the page shows which secrets exist and when each changed, never a value.
- The Supabase API keys are not editable: setup reads them from the project.

## Amendments, 2026-10-15

**Automate everything an API allows** (asked by the owner). Checked:

- Vercel: a CLI sign-in (`vercel login`) creates projects, links and sets variables, but
  `POST /v3/user/tokens` answers 403 "Cannot create tokens for this app". The CI token is copied
  once from vercel.com/account/tokens.
- Supabase: no endpoint creates access tokens. The token does create the project
  (`POST /v1/projects`), its API keys and its auth settings, so the dashboard is not needed. It is
  used during setup only: releases connect with the database password and its address
  (`SUPABASE_POOLER_URL`), which reach one project instead of the whole account.
- GitHub: a fine-grained token cannot be created by API, but a GitHub App can, from a manifest,
  with two clicks. It replaced the pasted token: nothing to copy, no expiry, one-hour tokens.
- MCP servers (Vercel, Supabase) act for the person inside an AI session; neither the deployed
  app nor a workflow can use them, so they do not change this (not tested further).

**One path.** The GitHub-only setup (values pasted into GitHub, a Bootstrap workflow) was removed:
with the app it is strictly more work, and two ways to do the same thing is friction of its own.
Every user already has `gh` (the README's first command needs it).

## Consequences

- Easier: every credential change from the deployed app; a new project needs two pasted tokens
  and two clicks on GitHub, and no dashboard otherwise.
- Harder: a change takes minutes (a release) instead of seconds; each project has its own GitHub
  App, which stays in the owner's GitHub settings until deleted there.
- Revisit if GitHub lets a token read environments without Administration, or if Vercel offers
  project-scoped tokens.
