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
| SYS-3 | hand the regulation step the case content tagged by file and page, plus optional free-form notes from a cheap model | N-1, N-2, N-4 | ingest, regs | T, S | 2 | — |
| SYS-23 | ingest a regulations `index.json` automatically: download, verify checksums, store by version, page and paragraph | N-13, N-1, N-2 | regs, db | T, I | 3 | #3 |
| **Output** | | | | | | |
| SYS-4 | output a main-goal JSON that `validate.py` accepts, with `team_id` and `case_id` | N-7 | regs, checks | T | 4 | #4 |
| SYS-5 | cite only catalogue regulations, with the **base** `version_label` and a page of that PDF | N-2, N-7 | regs | T | 3, 5 | #3, #4 |
| SYS-6 | cite the paragraph label of every requirement | N-1, N-2 | regs | T | 3 | #3 |
| SYS-7 | state one engineering obligation per requirement | N-1, N-4, N-5 | regs | S, I | — | #4 |
| SYS-8 | reach regulation-level recall ≥ `TBD` and page-level recall ≥ `TBD` on the dev case | N-1, N-4 | ingest, regs | S | — | #4 |
| SYS-9 | (should) give a test case per requirement | N-5 | regs | I | — | — |
| **Checks** | | | | | | |
| SYS-10 | run `validate.py` (unchanged) automatically on each run's output JSON and show every problem with its JSON path | N-7 | checks, web | T | 5 | — |
| SYS-11 | score the output JSON against the dev case's `expected.json` with `score_local.py` and show regulation and page scores | N-1, N-12 | checks, web | D | 5 | — |
| **Review and deployability** | | | | | | |
| SYS-12 | link each requirement to its source page in the web | N-2 | web | D | — | #6 |
| SYS-13 | require one person's approval ("approve all") before export or submission | N-9 | regs, web | T | — | #6 |
| SYS-14 | go from upload to a validated JSON with no manual step | N-8 | all | D | 1–5 | #4 |
| SYS-15 | finish a run within `RUN_TIMEOUT_S` = 270 s | N-8 | regs, ingest, ops | T | 3 | — |
| SYS-16 | never commit case files or Certivity data, and purge them, Storage included | N-9 | db, ops | I, T | 1, 5 | — |
| SYS-17 | record every model message, tool call, check and approval in `run_events` | N-9, N-12 | regs, db | T | — | — |
| SYS-18 | (may) export to Polarion or Jama (ReqIF or CSV) | N-10 | web | D | — | — |
| **Sub-goal** | | | | | | |
| SYS-19 | output a sub-goal JSON that `validate.py --requirements-old` accepts: modified, removed or added, with the reason | N-6, N-7 | regs, checks | T, S | 5 | #5 |
| **Event operations** | | | | | | |
| SYS-20 | make the best-scoring file the last valid held-out upload, before Sunday 13:00 | N-7 | ops | I | 6 | #7 |
| SYS-21 | submit repository, demo and answers on the organisers' platform | N-11 | ops | I | — | — |
| SYS-22 | present only measured scores, and where the system is weak | N-12 | ops | I | — | — |

SYS-23 has a number out of order because it was added after SYS-1 to SYS-22. Ids are never
renumbered.

## Rationale and notes

| Id | Why, and what to watch |
|---|---|
| SYS-1 | CAD in by Clemente's decision (2026-10-24). In v1 a CAD file is stored and only its readable text reaches the model. STEP/IGES carry part names, binary STL almost nothing, and no geometry is rendered. Future: .pptx, .doc, .zip; reuse Ramón's PDF layer (#3) for case PDFs |
| SYS-2 | A page the model never saw is a requirement nobody finds, and the engineer cannot tell |
| SYS-3 | Certivity could not confirm fixed product attributes (2026-10-24), so there is no fixed schema. The notes are a help, not a contract. Was "case profile" until 2026-10-24 |
| SYS-23 | The same mechanism loads any customer's regulation set (Clemente, 2026-10-24) |
| SYS-4 | CR1. The platform runs the same check, and a rejected file does not count |
| SYS-5 | CR2. A page of the `latest` version counts as a wrong page. **Same-name risk:** `validate.py` checks against the `index.json` file, not our database, so the catalogue keeps its exact strings and the file stays available to the checks |
| SYS-6 | A page counts if the page *or* the paragraph is right, so the paragraph covers an off-by-one page |
| SYS-7 | Matching is one to one, so merging two obligations loses recall (Brief 07) |
| SYS-8 | F2 favours recall. Targets will be set from the first baseline, not invented |
| SYS-10 | A check, not a write: nobody approves it. It saves wasting one of the 5 uploads/hour |
| SYS-11 | Only the dev case has an answer file. `index.json` plays no part in this check |
| SYS-13 | One click for the whole list. Per-requirement accept/reject is future work for client engineers |
| SYS-15 | Not measured. If it doesn't fit, the architecture changes (pre-computed index, or the `agent/Dockerfile` container) |
| SYS-16 | AGENTS.md, LICENSE-DATA.md. The purge script deletes rows only today, not bucket objects |
| SYS-20 | The **last** valid upload counts, not the best. Procedure in `docs/hackathon.md` |

## Traceability: needs to requirements

| Need | Satisfied by |
|---|---|
| N-1 Completeness | SYS-2, 3, 6, 7, 8, 11, 23 |
| N-2 Checkable source | SYS-3, 5, 6, 12, 23 |
| N-3 Input as I have it | SYS-1, 2 |
| N-4 No noise | SYS-3, 7, 8 |
| N-5 Actionable wording | SYS-7, 9 |
| N-6 Stale requirements | SYS-19 |
| N-7 Accepted submission | SYS-4, 5, 10, 19, 20 |
| N-8 End to end | SYS-14, 15 |
| N-9 Deployable | SYS-2, 13, 16, 17 |
| N-10 Fits their tooling | SYS-18 |
| N-11 Submitted | SYS-21 |
| N-12 Shows its weakness | SYS-11, 17, 22 |
| N-13 Reusable regulation set | SYS-23 |

Every need has at least one requirement, and every requirement has at least one need.

## Allocation: parts to requirements

| Part | Requirements |
|---|---|
| web | SYS-1, 10, 11, 12, 13, 14, 18 |
| ingest | SYS-1, 2, 3, 8, 14, 15 |
| regs | SYS-3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 17, 19, 23 |
| checks | SYS-4, 10, 11, 14, 19 |
| db | SYS-1, 16, 17, 23 |
| ops | SYS-15, 16, 20, 21, 22 |
