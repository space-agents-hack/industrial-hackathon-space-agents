# Certivity's checks, copied

Everything here except this file comes from the Certivity hackathon package, unchanged, through
`scripts/sync-certivity.sh`. `SOURCE` names the commit and the hash of each file; a test fails if
a file differs from it. To update, pull the package and run the script again; never edit here.

Why a copy and not a rewrite: Certivity's platform runs this same `validate.py` on every upload,
so the copy is what makes "valid on our web" mean "accepted on upload".

**The data is confidential.** `tools/` and `schemas/` are MIT. `regulations/index.json` and the
files under `cases/` and `subgoal/` are for the Certivity hackathon only (`LICENSE-DATA.md`): they
are committed here because the repository is private and Clemente decided so on 2026-10-24, and
they must be deleted after the event with the rest of the challenge material.

What reads them: `agent_service/certivity.py`, for the `POST /checks` endpoint and the agent's
`certivity_check` tool. The score only exists for cases that ship an `expected.json`, which today
is only the worked example.
