# System requirements

All `proposed` (Claude, 2026-10-24); not yet reviewed by Clemente or Ramón (#11). Owners live on
the issues. Needs: `stakeholders.md`. Verification: `verification.md`.

**Allocation:** web = `web/` · ingest = case files to tagged case content · regs = regulation
catalogue and requirement extraction · checks = Certivity `validate.py` / `score_local.py` ·
db = `supabase/` · ops = deploy, uploads, people.
**Verification:** T test · S score · D demonstration · I inspection.

## Requirements

| Id | The system shall... | Needs | Alloc | Ver | IF | Issue |
|---|---|---|---|---|---|---|
| **Input** | | | | | | |
| SYS-1 | accept a case as several files: .md .txt .pdf .png .jpg .docx, CAD .step/.stp .iges/.igs .stl | N-3 | web, ingest, db | T | 1 | #8 |
| SYS-2 | pass every accepted file to the model as text or image, and list in the trace what was read, skipped or truncated per file | N-1, N-3, N-9 | ingest | T | 1 | #8 |
| SYS-3 | hand the regulation step the case content tagged by file and page, plus optional free-form notes from a cheap model | N-1, N-2, N-4 | ingest, regs | T, S | 2 | #4, #8 |
| SYS-23 | ingest a regulations `index.json` automatically: download, verify checksums, store by version, page and paragraph, with embeddings for retrieval | N-13, N-1, N-2 | regs, db | T, I | 3 | #3 |
| SYS-24 | store every case (files, extracted content, notes, outputs) in the database and Storage under the user's organisation, readable only by that organisation's members; nothing case-specific in the repository | N-3, N-9 | db, ingest, web | T | 1, 2 | #8 |
| **Output** | | | | | | |
| SYS-4 | output a main-goal JSON that `validate.py` accepts, with `team_id` and `case_id` | N-7 | regs, checks | T | 4 | #4 |
| SYS-5 | cite only catalogue regulations, with the **base** `version_label` and a page of that PDF | N-2, N-7 | regs | T | 3, 5 | #3, #4 |
| SYS-6 | cite the paragraph label of every requirement | N-1, N-2 | regs | T | 3 | #3 |
| SYS-7 | state one engineering obligation per requirement | N-1, N-4, N-5 | regs | S, I | — | #4 |
| SYS-8 | reach regulation-level recall ≥ `TBD` and page-level recall ≥ `TBD` on the dev case | N-1, N-4 | ingest, regs | S | — | #4 |
| SYS-9 | (should) give a test case per requirement | N-5 | regs | I | — | #4 |
| SYS-25 | write requirements from a case's content and the paragraphs of the regulations linked to it, each requirement stored with a link to the catalogue paragraph it comes from | N-1, N-2, N-5 | regs, db | T, S | 2, 3, 4 | #4 |
| **Checks** | | | | | | |
| SYS-10 | run `validate.py` (unchanged) automatically on each run's output JSON and show every problem with its JSON path | N-7 | checks, web | T | 5 | #15 (built) |
| SYS-11 | for `dev-rear-lamp` only, score the output JSON against its `expected.json` with `score_local.py` and show regulation and page scores | N-1, N-12 | checks, web | D | 5 | #15 (built) |
| **Review and deployability** | | | | | | |
| SYS-12 | link each requirement to its source page in the web | N-2 | web | D | — | #6 |
| SYS-13 | require one person's approval ("approve all") before export or submission | N-9 | regs, web | T | — | #6 |
| SYS-14 | go from upload to a validated JSON with no manual step | N-8 | all | D | 1–5 | #4 |
| SYS-15 | finish a run within `RUN_TIMEOUT_S` = 770 s (Vercel Pro cap 800 s) | N-8 | regs, ingest, ops | T | 3 | #14 |
| SYS-16 | never commit case files or Certivity data (it lives in table `certivity_reference`); purge both after the event, Storage included | N-9 | db, ops | I, T | 1, 5 | #16 |
| SYS-17 | record every model message, tool call, check and approval in `run_events` | N-9, N-12 | regs, db | T | — | #6 |
| SYS-18 | (may) export to Polarion or Jama (ReqIF or CSV) | N-10 | web | D | — | #6 |
| **Sub-goal** | | | | | | |
| SYS-19 | output a sub-goal JSON that `validate.py --requirements-old` accepts: modified, removed or added, with the reason | N-6, N-7 | regs, checks | T, S | 5 | #5 |
| **Event operations** | | | | | | |
| SYS-20 | make the best-scoring file the last valid held-out upload, before Sunday 13:00 | N-7 | ops | I | 6 | #7 |
| SYS-21 | submit repository, demo and answers on the organisers' platform | N-11 | ops | I | — | #1, #7 |
| SYS-22 | present only measured scores, and where the system is weak | N-12 | ops | I | — | #6 |
| **Future work (not built this weekend)** | | | | | | |
| SYS-26 | (may) find regulations for a given country or industry on the web and other sources, and write them as an `index.json` in Certivity's format, which SYS-23 then ingests | N-14 | regs | D | 3 | #17 |

SYS-23 to SYS-26 are numbered out of order because they were added later. Ids are never renumbered.

## Rationale and notes

| Id | Why, and what to watch |
|---|---|
| SYS-1 | CAD in by Clemente's decision (2026-10-24). In v1 a CAD file is stored and only its readable text reaches the model. STEP/IGES carry part names, binary STL almost nothing, and no geometry is rendered. Future: .pptx, .doc, .zip; reuse Ramón's PDF layer (#3) for case PDFs |
| SYS-2 | A page the model never saw is a requirement nobody finds, and the engineer cannot tell |
| SYS-3 | Certivity could not confirm fixed product attributes (2026-10-24), so there is no fixed schema. The notes are a help, not a contract. Was "case profile" until 2026-10-24 |
| SYS-23 | The same mechanism loads any customer's regulation set (Clemente, 2026-10-24). Ramón owns the ingestion and vectorisation (#3) |
| SYS-24 | Clemente, 2026-10-24: "it shall be DB". Today there is one organisation (the default). Reference data follows the same rule (SYS-16) |
| SYS-25 | The link to the catalogue paragraph (not only the citation strings) is what lets a requirement be traced to a regulation paragraph later, and lets SYS-19 find the requirements a changed paragraph affects. One agent or several is a design decision, still open |
| SYS-26 | Clemente, 2026-10-24: only if time allows. Kept here so it is not lost; issue #17 holds it |
| SYS-4 | CR1. The platform runs the same check, and a rejected file does not count |
| SYS-5 | CR2. A page of the `latest` version counts as a wrong page. **Same-name risk:** `validate.py` checks against the `index.json` file, not our database, so the catalogue keeps its exact strings and the file stays available to the checks |
| SYS-6 | A page counts if the page *or* the paragraph is right, so the paragraph covers an off-by-one page |
| SYS-7 | Matching is one to one, so merging two obligations loses recall (Brief 07) |
| SYS-8 | F2 favours recall. Targets will be set from the first baseline, not invented |
| SYS-10 | A check, not a write: nobody approves it. It saves wasting one of the 5 uploads/hour |
| SYS-11 | Only `dev-rear-lamp` has an answer file. On the held-out case the web shows validation (SYS-10) and says no local score exists; the score comes only from the platform. `index.json` plays no part in this check |
| SYS-13 | One click for the whole list. Per-requirement accept/reject is future work for client engineers |
| SYS-15 | Vercel Pro (Clemente, 2026-10-24): `maxDuration` 800 in `agent/vercel.json` and the three web routes that hold the connection; 30 s margin so a slow run ends as `failed`, not killed. Regulation ingestion (SYS-23) never runs inside a run. Not measured. Fallback beyond 800 s: the `agent/Dockerfile` container on the Raspberry Pi or Ramón's VPS |
| SYS-16 | Clemente's decision (2026-10-24): `index.json`, `expected.json` and `requirements_old.json` live in the database (table `certivity_reference`), so purging them is deleting rows; from ac791c2 until the move they were in git, so history still holds them until the repository is deleted or archived. Case files stay out of git; the purge script must also empty the `case-files` bucket (#16) |
| SYS-20 | The **last** valid upload counts, not the best. Procedure in `docs/hackathon.md` |

## Traceability: needs to requirements

| Need | Satisfied by |
|---|---|
| N-1 Completeness | SYS-2, 3, 6, 7, 8, 11, 23, 25 |
| N-2 Checkable source | SYS-3, 5, 6, 12, 23, 25 |
| N-3 Input as I have it | SYS-1, 2, 24 |
| N-4 No noise | SYS-3, 7, 8 |
| N-5 Actionable wording | SYS-7, 9, 25 |
| N-6 Stale requirements | SYS-19 |
| N-7 Accepted submission | SYS-4, 5, 10, 19, 20 |
| N-8 End to end | SYS-14, 15 |
| N-9 Deployable | SYS-2, 13, 16, 17, 24 |
| N-10 Fits their tooling | SYS-18 |
| N-11 Submitted | SYS-21 |
| N-12 Shows its weakness | SYS-11, 17, 22 |
| N-13 Reusable regulation set | SYS-23 |
| N-14 More markets | SYS-26 (future) |

Every need has at least one requirement, and every requirement has at least one need.

## Allocation: parts to requirements

| Part | Requirements |
|---|---|
| web | SYS-1, 10, 11, 12, 13, 14, 18, 24 |
| ingest | SYS-1, 2, 3, 8, 14, 15, 24 |
| regs | SYS-3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 17, 19, 23, 25, 26 |
| checks | SYS-4, 10, 11, 14, 19 |
| db | SYS-1, 16, 17, 23, 24, 25 |
| ops | SYS-15, 16, 20, 21, 22 |
