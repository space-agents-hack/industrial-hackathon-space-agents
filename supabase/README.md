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

Created once by setup (`scripts/bootstrap.sh`, from the local Setup page), which also turns new sign-ups off
and sets the site address through the Supabase API. If it reports it could not, do it in the
dashboard: Authentication, Sign In / Providers, "Allow new users to sign up" off; Authentication,
URL Configuration, Site URL set to the web's production address.

Self sign-up (SYS-35) needs "Allow new users to sign up" on. That is safe because an account alone
opens nothing: it belongs to no organisation, and RLS shows it nothing, until an organisation's
admin approves its request to join, or a platform admin approves the new organisation it asked for
(Settings, People and Settings, Organisations). With "Confirm email" on, Supabase's built-in
mailer sends only a few emails an hour; either turn confirmation off for the demo or configure
SMTP. Add `<web address>/auth/confirm` to the redirect URLs so the confirmation link signs the
person in. With sign-up off, the app's sign-up form says so and admins still create accounts.

Create users with the script. It asks for the password and does not accept the local default:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret key> scripts/create-user.sh ana@example.com
```

### Applying migrations by hand

The release workflow applies them when GitHub has `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`
and the `SUPABASE_POOLER_URL` variable (setup writes all three). To do it yourself instead, leave
them unset and run, after the checks are green on that commit:

```bash
supabase link --project-ref <ref>
supabase db push
```

## What this does not do

- No seed data on the hosted project: `seed.sql` runs only on a local reset.
- Two storage buckets, both private and created by migrations: `case-files` (the engineer's
  uploads, `20261024160000_case_files`, issue #8) and `regulations` (the library's PDFs,
  `20261024180000_regulations`). Objects do not go away when their rows are deleted, and the purge
  script does not empty either bucket yet (#16). No edge functions or scheduled jobs.
- Isolation is per organisation, not per person: everyone in an organisation reads all its runs
  and case files. See `docs/architecture.md`, "Who can do what".
