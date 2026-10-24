# Interface control

All `proposed`. **Owners are `UNASSIGNED` until Clemente or Ramón assigns them.** Assigned 2026-10-24 by Clemente: case side Clemente, regulation side Ramón, output both. Nobody fills
them in on their behalf. A change needs both owners to agree on the issue before merge.

## Interface register

| IF | From → To | Carries | Owner (from / to) | SYS | Issue |
|---|---|---|---|---|---|
| IF-1 | web → db/Storage → ingest | Case files, under organisation → project → case | Clemente / Clemente | 1, 2, 16, 24, 27 | #8, #19 |
| IF-2 | ingest → regs | Standardised content blocks stored per case (file, page), plus optional notes | Clemente / Clemente + Ramón | 2, 3, 8, 24, 25, 27, 28 | #4, #19 |
| IF-3 | regs catalogue → requirement writer | Paragraphs with regulation, version, page, paragraph | Ramón / Clemente + Ramón | 5, 6, 15, 23, 25, 28, 29, 32 | #3, #18, #24 |
| IF-4 | agent → db → web, checks | Run output: `submission_main` JSON | Clemente + Ramón / Clemente + Ramón | 4, 14, 25, 29 | #4 |
| IF-5 | Certivity → checks | `validate.py`, `score_local.py`, schemas, `expected.json`, `requirements_old.json` (the regulation list reaches the checks through the library, IF-3) | `UNASSIGNED` | 10, 11, 16, 19 | — |
| IF-6 | ops → Certivity platform | Uploads | `UNASSIGNED` (one person on Sunday) | 20 | #7 |

## N² view (what each part hands to the next)

| From \ To | web | ingest | regs | checks | Certivity |
|---|---|---|---|---|---|
| **web** | — | IF-1 files | | | |
| **ingest** | | — | IF-2 content | | |
| **regs** | IF-4 output | | IF-3 lookup | IF-4 output | |
| **checks** | IF-4 results | | | — | |
| **Certivity** | | | | IF-5 tools, answers | — |
| **ops** | | | | | IF-6 uploads |

## Details

| IF | Decided | Open |
|---|---|---|
| IF-1 | Storage bucket `case-files` (Vercel rejects bodies over 4.5 MB). Files belong to a case in a project of the organisation (migration `20261024190000_cases.sql`, 84a33a8); `run_files` still works until the web moves to cases. A check constraint on media type is the single list of formats | Size limits per file and per run. Purge must empty the bucket. Later: use Ramón's PDF layer (#3) for case PDFs |
| IF-2 | No fixed profile (Certivity could not confirm one). Table `case_file_blocks`: text or image, with file, page and the parser or model that made it, written once at upload; runs read them (`runs.case_id`). Parser first; `INGEST_MODEL` only for what parsers cannot read, marked as a transcription (SYS-27, ADR-0006, 84a33a8) | Whether the writer also gets free-form product notes |
| IF-3 | Catalogue loaded from `index.json` (SYS-23). `regulation` and `version_label` strings are kept exactly as in the file | Query and response shape. Pre-computed or built during the run (`RUN_TIMEOUT_S`, SYS-15). SYS-32 (project chooses its regulations, #24) filters this lookup: agreed by Clemente, waiting on Ramón |
| IF-4 | Output is the Certivity JSON itself, as a typed output, never free text | Source of `team_id` (a setting) and `case_id` |
| IF-5 | Tools and schemas copied unchanged into `agent/certivity/` by `scripts/sync-certivity.sh` (ac791c2); the answer files (`expected.json`, `requirements_old.json`) in table `certivity_reference`, loaded by `make certivity-load`, read by the agent only. Since d1b2c15 the regulation list lives only in the organisation's library (ADR-0006). No bucket. Check results are not stored per run | — |
| IF-6 | 5 valid uploads per hour per challenge. The **last** valid held-out upload counts. Uploads close Sunday 13:00 | Unconfirmed: whether dev-case and held-out uploads share the same quota. Ask Certivity |
