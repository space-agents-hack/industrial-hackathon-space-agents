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
   environment, as before. The app holds one fine-grained token for this repository only
   (`GITHUB_CONTROL_TOKEN`: Actions, Environments, Secrets, Variables), which can *write* a
   secret but never read one back, and start workflows. Admin › Deployment seals a new value to
   the environment's public key, stores it, and starts a release that copies it to Vercel first. Platform admins only, password typed again, audit row
   with the names of what changed.
2. **The first deployment needs three pasted tokens and nothing else** (amended 2026-10-15, below).

## Options considered

| Option | Assessment |
|---|---|
| A. GitHub as control plane (chosen) | The app never holds the Vercel or Supabase tokens. Worst case of a stolen admin session: values overwritten and main redeployed; no token read, no code changed. Costs one more token, which expires (up to a year) |
| B. The app holds every token in Vault, calls Vercel and Supabase directly | Simplest and fastest to use; one breach exposes every project in both accounts |
| C. Credentials stay on a laptop | Safest; the inconvenience the owner rejected |

## What this does not do

- The token has no Administration permission, so it cannot restrict the `production` environment
  to `main`; that is one click, listed in the setup steps. With it, the token could delete the
  repository.
- No read-back: the page shows which secrets exist and when each changed, never a value.
- The Supabase API keys are not editable: the workflow reads them from the project.

## Amendment, 2026-10-15: automate everything an API allows

The owner asked for every step an API or CLI can do to be automated. Checked:

- Vercel: a CLI sign-in (`vercel login`) creates projects, links and sets variables, but
  `POST /v3/user/tokens` answers 403 "Cannot create tokens for this app". The CI token is copied
  once from vercel.com/account/tokens.
- Supabase: no endpoint creates access tokens. The token does create the project
  (`POST /v1/projects`), its API keys and its auth settings, so the dashboard is not needed.
- GitHub: a fine-grained token cannot be created by API. `gh` writes every secret, variable and
  the branch rule.
- MCP servers (Vercel, Supabase) act for the person inside an AI session; neither the deployed
  app nor a workflow can use them, so they do not change this (not tested further).

So the usual path is one form on the local Setup page (`gh` signed in): three tokens, an email
and a password; `scripts/bootstrap.sh` does the rest and releases. The GitHub-alone path stays for
machines without the CLIs. The Supabase token is no longer stored for releases: GitHub keeps
the database password and its address (`SUPABASE_POOLER_URL`), which reach one project instead
of the whole account. Admin › Deployment applies changes by starting a release that copies them
to Vercel, instead of re-running Bootstrap.

## Consequences

- Easier: every credential change from the deployed app; a new project needs three tokens and
  `gh`, or GitHub alone, and no dashboard otherwise.
- Harder: a change takes minutes (workflow, then release) instead of seconds; the control token
  has to be renewed before it expires.
- Revisit if GitHub lets a token read environments without Administration, or if Vercel offers
  project-scoped tokens.
