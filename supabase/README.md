# Database

The schema in `migrations/` is the contract between `agent/` and `web/`. Read the header of
`migrations/20261013000000_init.sql` for who writes what and who can see what.

## Local

This section is about the local database in Docker. Without Docker (`make setup DB=hosted`) the
commands below that touch the local stack do not apply.

`make setup` starts the stack and creates the demo user. Ports are the Supabase defaults plus 100
so this project does not collide with another one running on the same machine:

- API `http://127.0.0.1:54421`
- Database `postgresql://postgres:postgres@127.0.0.1:54422/postgres`
- Studio `http://127.0.0.1:54423`

| Command | What it does |
|---|---|
| `make check-db` | Applies new migrations, runs the RLS tests, lints the SQL, runs the agent's contract test |
| `make db-reset` | Wipes the local database, re-applies everything, re-creates the demo user |
| `make types` | Regenerates `web/lib/database.types.ts` |
| `make user EMAIL=...` | Creates another local user |

## Changing the schema

1. `supabase migration new <what_it_does>` and write the SQL. Enable RLS on every new table and
   grant privileges explicitly: the first migration shows the pattern and the reason.
2. Add a pgTAP test in `tests/` for what each policy allows and what it refuses.
3. `make check-db`, then `make types`.
4. Make it work with the code that is already deployed: add columns as nullable or with a
   default; do not rename or drop what running code reads. Migrations are applied before the new
   code goes live.
5. Never edit a migration that has reached `main`, and always create one with
   `supabase migration new` right before committing, so it sorts after everything already on
   `main`. `make check` and CI enforce both (`scripts/check-migrations.sh`).

## Hosted project

Created once by the Bootstrap workflow (`scripts/bootstrap.sh`), which also turns new sign-ups off
and sets the site address through the Supabase API. If it reports it could not, do it in the
dashboard: Authentication, Sign In / Providers, "Allow new users to sign up" off; Authentication,
URL Configuration, Site URL set to the web's production address. Sign-ups must stay off: every
signed-in user sees every run and can spend model credits.

Create users with the script. It asks for the password and does not accept the local default:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret key> scripts/create-user.sh ana@example.com
```

### Applying migrations by hand

The release workflow applies them when the three Supabase secrets are set. To do it yourself
instead, leave those secrets unset and run, after the checks are green on that commit:

```bash
supabase link --project-ref <ref>
supabase db push
```

## What this does not do

- No seed data on the hosted project: `seed.sql` runs only on a local reset.
- No storage buckets, edge functions or scheduled jobs. Add them when a project needs them.
- No per-user or per-team isolation. See `docs/architecture.md`, "What this does not do".
