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

Nothing pending. Everything found up to 2026-10-13 was ported: per-clone local database
identity, bootstrap reading keys and creating users, Frankfurt region, the Setup page, optional
Docker.

Verified on 2026-10-14: the setup form, bootstrap and the full release. Still unverified:
`make setup DB=hosted`, and a full run with approval in production.
