# Interface control

Where two parts built by different people or agents meet. Each interface has one owner per side.
**Owners are `UNASSIGNED` until Clemente or Ramón assigns them**; nobody fills them in on their
behalf. Change rule: the owners of both sides agree on the issue before the change is merged
(`README.md` in this folder).

All interfaces below are `proposed`. Designs in progress are in the project's shared folder
(`design/case-ingestion.md`, `design/certivity-checks-on-web.md`), not in the repo yet.

## IF-1 Case files: web to database to agent

- Producer: web (upload form). Consumer: ingest (agent). Carrier: db and Supabase Storage.
- Owners: web side `UNASSIGNED`, agent side `UNASSIGNED`.
- Proposed: the browser uploads each file to a private Storage bucket `case-files`; a new table
  `run_files` (run, organisation, storage path, filename, media type, bytes, sha256) lists them;
  a check constraint on media type holds the accepted formats, so web and agent read one list.
- Why not issue #8's `run_inputs` table of bytes: a Vercel function rejects request bodies over
  4.5 MB, and a PDF datasheet can exceed it; bytes in Postgres count against database size.
- Requirements: SYS-1, SYS-2, SYS-16. Issue: #8 (to be updated or superseded).
- Open: per-file and per-run limits; whether `purge-challenge-data.sh` empties the bucket.

## IF-2 Case profile: ingest to regulation pipeline

- Producer: ingest (case agent). Consumer: regs (regulation selection and extraction).
- Owners: producer `UNASSIGNED`, consumer `UNASSIGNED` (Ramón is building the regulation side).
- Proposed: a Pydantic model in `agent/agent_service/domain/case.py`. Fields under discussion:
  product type, vehicle categories, functions, components (name, material, notes), markings,
  light sources, open questions, and evidence (claim, file, page).
- **Settle this one first**: both ends are being built today by different people.
- Requirements: SYS-3, SYS-8. Issue: none yet.

## IF-3 Regulation lookup: regulation index to requirement writer

- Producer: regs (index of the base-version PDFs at paragraph level with page numbers).
  Consumer: whatever writes the requirements (agent tools).
- Owners: producer `UNASSIGNED`, consumer `UNASSIGNED`.
- To define: query in (regulation, topic, paragraph?), paragraphs out with regulation, version
  label, page and paragraph label; whether it is pre-computed or built during the run (SYS-15:
  the run has 270 s).
- Requirements: SYS-5, SYS-6, SYS-15. Issue: #3.

## IF-4 Run output: agent to database to web

- Producer: regs (the run's final output). Consumers: checks, web (display, export, download).
- Owners: producer `UNASSIGNED`, consumer `UNASSIGNED`.
- Proposed: the output is the Certivity `submission_main` JSON itself, produced as a Pydantic
  output type that matches `submission_main.schema.json`, so the model cannot return free text.
  Today `runs.output` is plain text.
- Open: where `team_id` comes from (an agent setting, not hard-coded); where `case_id` comes from.
- Requirements: SYS-4, SYS-14. Issue: #4.

## IF-5 Certivity tools and reference data

- Producer: Certivity (`tools/validate.py`, `tools/score_local.py`, `schemas/`, MIT) and the
  reference data (`regulations/index.json`, `cases/*/expected.json`, hackathon use only).
  Consumers: checks (agent), regs (reads `index.json` too).
- Owners: `UNASSIGNED`.
- Proposed: tools and schemas copied unchanged into the agent, with a hash test and a sync
  command for when Certivity updates them; reference data in a private Storage bucket
  `challenge`, read at run time, never committed, purged after the event.
- Why unchanged: Certivity says the platform runs the same `validate.py`; a rewrite loses that.
- Requirements: SYS-10, SYS-11, SYS-16, SYS-19. Issue: none yet.

## IF-6 Certivity platform: us to Certivity

- Producer: ops (a person uploads). Consumer: Certivity scoring platform.
- Owner: `UNASSIGNED` (one named person should hold the uploads on Sunday).
- Limits: 5 valid uploads per hour per challenge (main goal, sub-goal); invalid files do not
  count. Held-out: the **last** valid upload counts. Uploads close Sunday 13:00.
- Assumption, not checked: uploads for the dev case and the held-out case share the hourly quota
  of the same challenge. Ask Certivity.
- Requirements: SYS-20. Issue: #7.
