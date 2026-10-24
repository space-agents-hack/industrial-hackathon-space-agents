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
| SYS-23 | ingest a regulations `index.json` automatically: download, verify checksums, store by version, page and paragraph, with embeddings for retrieval | N-13, N-1, N-2 | regs, db | T, I | 3 | #3, #18 |
| SYS-24 | store all case data in the database and Storage as organisation → projects → cases → requirements, shared by every member of that organisation and readable by no one else; nothing case-specific in the repository | N-3, N-9, N-15 | db, ingest, web | T | 1, 2 | #8, #19 |
| SYS-27 | ingest each case file with a deterministic parser first, send any file or part the parser fails on or does not recognise to a model, and store both results as the same standardised content blocks in the database | N-1, N-3 | ingest, db | T | 1, 2 | #8, #19 |
| SYS-31 | let every member of the organisation browse, create and rename projects and cases, add and remove a case's files, and see each file's parsed content by page | N-15, N-2, N-3 | web, db | D | 1, 2 | #23 |
| SYS-32 | let a member choose which regulations of the organisation's library a project uses; by default all of them, including later imports | N-13, N-4 | web, db, regs | T, D | 3 | #24 |
| SYS-33 | let an organisation admin choose the model of each agent and process (writer, check, case transcription, summaries, embeddings), defaulting to the deployment's, and let a member override the writer and check models for one run | N-9, N-12 | web, db, regs, ingest | T | 2, 4 | #25 |
| SYS-35 | let a signed-in person with no organisation either ask to join an existing organisation, which one of its admins approves or declines, or ask for a new organisation of which they become admin; no one sees an organisation's data before being approved | N-15, N-9 | web, db | T | 1 | #26 |
| SYS-36 | after sign-in, make the person pick a project of their organisation, or only offer to create one if it has none; show Runs, Regulations, Changes and Checks only inside the selected project | N-15, N-8 | web | T, D | — | #26 |
| SYS-37 | gather setup and administration in one Settings area shown only to organisation admins, with the deployment-wide parts shown only to platform admins | N-9 | web, db | T | — | #26 |
| **Output** | | | | | | |
| SYS-4 | output a main-goal JSON that `validate.py` accepts, with `team_id` and `case_id` | N-7 | regs, checks | T | 4 | #4 |
| SYS-5 | cite only catalogue regulations, with the **base** `version_label` and a page of that PDF | N-2, N-7 | regs | T | 3, 5 | #3, #4 |
| SYS-6 | cite the paragraph label of every requirement | N-1, N-2 | regs | T | 3 | #3 |
| SYS-7 | state one engineering obligation per requirement | N-1, N-4, N-5 | regs | S, I | — | #4 |
| SYS-8 | reach regulation-level recall ≥ `TBD` and page-level recall ≥ `TBD` on the dev case | N-1, N-4 | ingest, regs | S | — | #4 |
| SYS-9 | (should) give a test case per requirement | N-5 | regs | I | — | #4 |
| SYS-28 | pick candidate regulations by top-k embedding similarity between the case content and catalogue paragraphs, then read each selected regulation in full before writing requirements from it | N-1, N-4, N-8 | regs | T, S | 2, 3 | #18, #4 |
| SYS-29 | run the writing under an orchestrator agent, then pass every requirement through a check agent that verifies it against the database (paragraph exists, its text supports the requirement, no duplicate) and lists the obligation paragraphs of the selected regulations that no requirement cites, before the output is final | N-2, N-4, N-7 | regs, checks | T, S | 3, 4 | #4 |
| SYS-25 | write requirements from a case's content and the paragraphs of the regulations linked to it, each requirement stored with a link to exactly one regulation, at the catalogue paragraph it comes from | N-1, N-2, N-5 | regs, db | T, S | 2, 3, 4 | #4, #19 |
| SYS-34 | keep every requirement linked to a regulation paragraph row that exists: re-extracting a regulation version never deletes the paragraph rows requirements cite (old rows are marked superseded); a requirement whose paragraph comes back with the same text is moved to the new row, and one whose paragraph changed or disappeared keeps its link, is marked for re-check, and goes back through the check agent | N-2, N-13 | regs, db, checks | T | 3 | #3, #4 |
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
| SYS-30 | (may) run the agents on a local model (for example Ollama) instead of a hosted provider | N-9 | regs, ops | D | — | #21 |

SYS-23 to SYS-37 are numbered out of order because they were added later. Ids are never renumbered.

## Rationale and notes

| Id | Why, and what to watch |
|---|---|
| SYS-1 | CAD in by Clemente's decision (2026-10-24). In v1 a CAD file is stored and only its readable text reaches the model. STEP/IGES carry part names, binary STL almost nothing, and no geometry is rendered. Future: .pptx, .doc, .zip; reuse Ramón's PDF layer (#3) for case PDFs |
| SYS-2 | A page the model never saw is a requirement nobody finds, and the engineer cannot tell |
| SYS-3 | Certivity could not confirm fixed product attributes (2026-10-24), so there is no fixed schema. The notes are a help, not a contract. Was "case profile" until 2026-10-24 |
| SYS-23 | The same mechanism loads any customer's regulation set (Clemente, 2026-10-24). Ramón owns the ingestion and vectorisation (#3) |
| SYS-24 | Clemente, 2026-10-24: "it shall be DB", and several engineers of one company work on the same cases (for example the same car part). Projects group cases. Today there is one organisation (the default), and files hang off runs, not cases (#19). Reasons in ADR-0006 |
| SYS-27 | Clemente, 2026-10-24: parser first because it is cheap, repeatable and cites pages exactly. The model covers what the parser cannot read. One block format, so the regulation step does not care which one produced a block |
| SYS-25 | The link to the catalogue paragraph (not only the citation strings) is what lets a requirement be traced to a regulation paragraph later, and lets SYS-19 find the requirements a changed paragraph affects. Agents: an orchestrator plus a check agent (SYS-29, Clemente 2026-10-24). Exactly one regulation per requirement (Clemente, 2026-10-24, correcting "at least one"), which matches the one `source` per requirement in Certivity's format |
| SYS-31 | Clemente, 2026-10-24 (UX thread, design/ux-hierarchy.md). Today a case is only created by starting a run, and nothing can be renamed or removed |
| SYS-32 | Clemente, 2026-10-24. "Linked" in SYS-25 means the project's regulations. IF-3 change agreed by Clemente and Ramón (2026-10-24). For the challenge project keep "all": a regulation left out is a miss, and F2 weighs misses four times as much as extras |
| SYS-33 | Clemente, 2026-10-24 (case-ingestion thread). Lets us compare models on the dev case and record which one produced a score (SYS-22) |
| SYS-34 | Clemente, 2026-10-24 (writer thread): "every requirement has to point to a real regulation id" and a re-run of PDF ingestion re-checks the requirements, without removing the previous rows. A re-extraction must not silently drop or orphan a person's requirements. Changes IF-3 (paragraph rows are superseded, not replaced): Ramón asked on #3, not agreed yet. Replaces the plain "not null" link of ADR-0006 |
| SYS-35 | Clemente, 2026-10-24 (UX thread). Needs self sign-up, which is off on purpose today (`supabase/README.md`); turning it on is a hosted Supabase setting that Clemente changes himself. **Open, Clemente's decision:** whether a platform admin approves a new organisation, because without that a stranger's runs are billed to the deployment's model keys, which have no monthly cap by default |
| SYS-36 | Clemente, 2026-10-24 (UX thread). Data ownership does not change: the regulation library stays per organisation (ADR-0006) and appears through the project's chosen regulations (SYS-32) |
| SYS-37 | Clemente, 2026-10-24 (UX thread): Setup and Admin joined. Deployment-wide settings (model keys, SYS-33 defaults) stay with platform admins, since they act on every organisation |
| SYS-26 | Clemente, 2026-10-24: only if time allows. Kept here so it is not lost; issue #17 holds it |
| SYS-28 | Clemente, 2026-10-24: embeddings (Ramón, #18) narrow 56 regulations fast; the full read keeps recall, since a paragraph the top-k misses inside a chosen regulation would otherwise be lost. Top-k only picks, it never decides alone that a regulation does not apply: the miss risk is regulation-level recall (SYS-8) |
| SYS-29 | Clemente, 2026-10-24. The check agent reads the DB, not the model's memory, so a hallucinated paragraph is caught before the file is uploaded. The uncovered-paragraph list is for recall, which F2 weighs most (Clemente, 18:29). It costs run time (SYS-15) |
| SYS-30 | Clemente, 2026-10-24: only if time allows. Confidential case files never leave the client's machines (#21). Ramón, 2026-10-24: an admin connects an Ollama server in Admin, Providers (URL, optional bearer or basic auth). Model calls then go to that server, and case ingestion stops sending scanned pages to a hosted model. Not covered yet: case files are still stored in the deployment's Supabase, and a hosted agent reaches only an Ollama it can route to |
| SYS-4 | CR1. The platform runs the same check, and a rejected file does not count |
| SYS-5 | CR2. A page of the `latest` version counts as a wrong page. **Same-name risk:** `validate.py` checks against the `index.json` file, not our database, so the catalogue keeps its exact strings and the file stays available to the checks |
| SYS-6 | A page counts if the page *or* the paragraph is right, so the paragraph covers an off-by-one page |
| SYS-7 | Matching is one to one, so merging two obligations loses recall (Brief 07) |
| SYS-8 | F2 favours recall. Targets will be set from the first baseline, not invented |
| SYS-10 | A check, not a write: nobody approves it. It saves wasting one of the 5 uploads/hour |
| SYS-11 | Only `dev-rear-lamp` has an answer file. On the held-out case the web shows validation (SYS-10) and says no local score exists; the score comes only from the platform. `index.json` plays no part in this check |
| SYS-13 | One click for the whole list. Per-requirement accept/reject is future work for client engineers |
| SYS-15 | Vercel Pro (Clemente, 2026-10-24): `maxDuration` 800 in `agent/vercel.json` and the three web routes that hold the connection; 30 s margin so a slow run ends as `failed`, not killed. Regulation ingestion (SYS-23) never runs inside a run. Not measured. Fallback beyond 800 s: the `agent/Dockerfile` container on the Raspberry Pi or Ramón's VPS |
| SYS-16 | Clemente's decision (2026-10-24): `expected.json` and `requirements_old.json` live in the database (table `certivity_reference`; the regulation list is in the organisation's library since d1b2c15), so purging them is deleting rows; from ac791c2 until the move they were in git, so history still holds them until the repository is deleted or archived. Case files stay out of git; the purge script must also empty the `case-files` bucket (#16) |
| SYS-20 | The **last** valid upload counts, not the best. Procedure in `docs/hackathon.md` |

## Traceability: needs to requirements

| Need | Satisfied by |
|---|---|
| N-1 Completeness | SYS-2, 3, 6, 7, 8, 11, 23, 25, 27, 28 |
| N-2 Checkable source | SYS-3, 5, 6, 12, 23, 25, 29, 31, 34 |
| N-3 Input as I have it | SYS-1, 2, 24, 27, 31 |
| N-4 No noise | SYS-3, 7, 8, 28, 29, 32 |
| N-5 Actionable wording | SYS-7, 9, 25 |
| N-6 Stale requirements | SYS-19 |
| N-7 Accepted submission | SYS-4, 5, 10, 19, 20, 29 |
| N-8 End to end | SYS-14, 15, 28, 36 |
| N-9 Deployable | SYS-2, 13, 16, 17, 24, 33, 35, 37, 30 (future) |
| N-10 Fits their tooling | SYS-18 |
| N-11 Submitted | SYS-21 |
| N-12 Shows its weakness | SYS-11, 17, 22, 33 |
| N-13 Reusable regulation set | SYS-23, 32, 34 |
| N-14 More markets | SYS-26 (future) |
| N-15 Shared work | SYS-24, 31, 35, 36 |

Every need has at least one requirement, and every requirement has at least one need.

## Allocation: parts to requirements

| Part | Requirements |
|---|---|
| web | SYS-1, 10, 11, 12, 13, 14, 18, 24, 31, 32, 33, 35, 36, 37 |
| ingest | SYS-1, 2, 3, 8, 14, 15, 24, 27, 33 |
| regs | SYS-3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 17, 19, 23, 25, 26, 28, 29, 30, 32, 33, 34 |
| checks | SYS-4, 10, 11, 14, 19, 29, 34 |
| db | SYS-1, 16, 17, 23, 24, 25, 27, 31, 32, 33, 34, 35, 37 |
| ops | SYS-15, 16, 20, 21, 22, 30 |
