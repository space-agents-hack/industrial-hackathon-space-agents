# Interface control

All `proposed`. **Owners are `UNASSIGNED` until Clemente or Ramón assigns them** (Clemente took case ingestion, 2026-10-24). Nobody fills
them in on their behalf. A change needs both owners to agree on the issue before merge.

## Interface register

| IF | From → To | Carries | Owner (from / to) | SYS | Issue |
|---|---|---|---|---|---|
| IF-1 | web → db/Storage → ingest | Case files | Clemente / Clemente | 1, 2, 16 | #8 |
| IF-2 | ingest → regs | Case content tagged by file and page, plus optional notes | Clemente / `UNASSIGNED` | 2, 3, 8 | — |
| IF-3 | regs catalogue → requirement writer | Paragraphs with regulation, version, page, paragraph | `UNASSIGNED` / `UNASSIGNED` | 5, 6, 15, 23 | #3 |
| IF-4 | agent → db → web, checks | Run output: `submission_main` JSON | `UNASSIGNED` / `UNASSIGNED` | 4, 14 | #4 |
| IF-5 | Certivity → checks, regs | `validate.py`, `score_local.py`, schemas, `index.json`, `expected.json` | `UNASSIGNED` | 10, 11, 16, 19 | — |
| IF-6 | ops → Certivity platform | Uploads | `UNASSIGNED` (one person on Sunday) | 20 | #7 |

## N² view (what each part hands to the next)

| From \ To | web | ingest | regs | checks | Certivity |
|---|---|---|---|---|---|
| **web** | — | IF-1 files | | | |
| **ingest** | | — | IF-2 content | | |
| **regs** | IF-4 output | | IF-3 lookup | IF-4 output | |
| **checks** | IF-4 results | | | — | |
| **Certivity** | | | IF-5 index | IF-5 tools, answers | — |
| **ops** | | | | | IF-6 uploads |

## Details

| IF | Decided | Open |
|---|---|---|
| IF-1 | Storage bucket `case-files` + table `run_files` (path, name, media type, bytes, sha256) instead of #8's table of bytes (Clemente, 2026-10-24). Reason: Vercel rejects bodies over 4.5 MB. A check constraint on media type is the single list of formats | Size limits per file and per run. Purge must empty the bucket. Later: use Ramón's PDF layer (#3) for case PDFs |
| IF-2 | No fixed profile, because Certivity could not confirm the attributes (2026-10-24). Blocks of text or image, each with file and page. Notes are free-form and cite a block | Block format. Which cheap model writes the notes (the template runs one model per run) |
| IF-3 | Catalogue loaded from `index.json` (SYS-23). `regulation` and `version_label` strings are kept exactly as in the file | Query and response shape. Pre-computed or built during the run (`RUN_TIMEOUT_S`, SYS-15) |
| IF-4 | Output is the Certivity JSON itself, as a typed output, never free text | Source of `team_id` (a setting) and `case_id` |
| IF-5 | Tools, schemas and the reference data the checks need, copied unchanged into `agent/certivity/` by `scripts/sync-certivity.sh` (built, ac791c2). No `challenge` bucket. Check results are not stored per run | — |
| IF-6 | 5 valid uploads per hour per challenge. The **last** valid held-out upload counts. Uploads close Sunday 13:00 | Unconfirmed: whether dev-case and held-out uploads share the same quota. Ask Certivity |
