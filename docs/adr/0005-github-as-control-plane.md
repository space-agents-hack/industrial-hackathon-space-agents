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
   the environment's public key, stores it, and starts the Bootstrap workflow, which carries it
   to Vercel and Supabase and releases. Platform admins only, password typed again, audit row
   with the names of what changed.
2. **The first deployment happens in GitHub too.** Paste five values into the environment, run
   the Bootstrap workflow. The local Connect form is removed; `scripts/bootstrap.sh` remains, as
   the workflow's engine and for a terminal.

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

## Consequences

- Easier: every credential change from the deployed app; a new project needs no CLI or Docker.
- Harder: a change takes minutes (workflow, then release) instead of seconds; the control token
  has to be renewed before it expires.
- Revisit if GitHub lets a token read environments without Administration, or if Vercel offers
  project-scoped tokens.
