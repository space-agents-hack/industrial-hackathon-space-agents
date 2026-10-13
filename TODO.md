# TODO

Open work on the template itself. Product work in a project made from this template goes here too.

## Before it can be trusted at an event

- [ ] First real deployment: run `scripts/bootstrap.sh`, push, and work through "Not yet verified
      on a real deployment" in `docs/deploy.md`.
- [ ] Run the example task once with each provider we intend to use (`make eval` with a real
      `AGENT_MODEL`) and note any difference in behaviour.
- [ ] One timed drill: from `gh repo create --template` to a deployed run with an approval. Write
      down every minute lost and fix the cause here.

## Known gaps

- [ ] No browser test of the full path (sign in, start a run, approve). See `docs/testing.md`.
- [ ] A run cannot be cancelled from the web.
- [ ] No follow-up message on a finished run (the saved conversation would allow it).

## Port back to the template

Found while building this repo from the template. Each one is a change to
`clemenjuan/industrial-agent-template`, not only to this repo.

- [ ] A clone shared the template's local database: `project_id` in `supabase/config.toml` names
      the Docker volumes. Fixed here with `scripts/name-project.sh`, called from `make setup`.
- [ ] `scripts/bootstrap.sh` asked for the Supabase keys and left sign-ups and users to do by
      hand. It now reads the keys from the project, turns sign-ups off and creates users.
- [ ] Functions ran in Vercel's default region (Washington) while the database is in Frankfurt:
      every event the agent writes crossed the Atlantic. Both `vercel.json` files now pin `fra1`.
      In the template this should be one documented setting next to the database region.
