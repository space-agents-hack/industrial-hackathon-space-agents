# Certivity's checks, copied

Everything here except this file is Certivity's code, copied unchanged from their hackathon
package by `scripts/sync-certivity.sh`: `tools/validate.py`, `tools/score_local.py`, `schemas/`
(MIT, `LICENSE`). `SOURCE` names the commit and the hash of each file; a test fails if a file
differs from it. To update, pull the package and run the script again; never edit here.

Why a copy and not a rewrite: Certivity's platform runs this same `validate.py` on every upload,
so the copy is what makes "valid on our web" mean "accepted on upload".

**No data here.** What the tools compare against (`regulations/index.json`, every `expected.json`
and `requirements_old.json`) is for the Certivity hackathon only (`LICENSE-DATA.md`), so it lives
in the database, table `certivity_reference`, where it can be deleted. Load it, locally or into
the database `agent/.env` points at, and again after every pull of the package:

    make certivity-load CERTIVITY=../industrial-ai-hackathon

What reads it: `agent_service/domain/certivity.py`, for `POST /checks` and the agent's
`certivity_check` tool. The score only exists for cases that ship an `expected.json`, which today
is only the worked example.
