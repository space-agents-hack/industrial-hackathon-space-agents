# TODO

Open work on the template itself. Product work in a project made from this template goes here too.

## Before it can be trusted at an event

- [x] First real deployment (hackathon-prep, 2026-10-14). See `docs/deploy.md`.
- [ ] A full run with approval in production, and `make setup DB=hosted` against a real project.
- [ ] Run the example task once with each provider we intend to use (`make eval` with a real
      `AGENT_MODEL`) and note any difference in behaviour.
- [ ] One timed drill: from `gh repo create --template` to a deployed run with an approval. Write
      down every minute lost and fix the cause here.

## Known gaps

- [ ] No browser test of the full path (sign in, start a run, approve). See `docs/testing.md`.
- [ ] A run cannot be cancelled from the web.
- [ ] Per-person API keys (today keys belong to the organisation).
- [ ] Purge hosted data after an event (`scripts/purge-challenge-data.sh --hosted`).
- [ ] One real OpenRouter one-click connection, end to end (tested only up to the redirect).
- [ ] No follow-up message on a finished run (the saved conversation would allow it).

## Next (asked on 2026-10-14)

- [x] Show a release's real progress (each job and step, live) in the app: Setup page and
      Admin › Releases (2026-10-15), where a platform admin can also start one.
- [x] Manage the deployment from production (ADR-0005): Admin › Deployment stores new values in
      GitHub and starts a release that copies them to Vercel.
- [x] One setup path: Connect GitHub (a GitHub App, two clicks), two pasted tokens, one form.
- [ ] Prove it on a fresh repository from the template, end to end: Connect GitHub, creating the
      Supabase project, the first release (written and tested in parts, never run for real).
