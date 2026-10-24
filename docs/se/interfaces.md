# Interface control

All `proposed`. **Owners are `UNASSIGNED` until Clemente or Ramón assigns them.** Assigned 2026-10-24 by Clemente: case side Clemente, regulation side Ramón, everything else both. Nobody fills
them in on their behalf. A change needs both owners to agree on the issue before merge.

## Interface register

| IF | From → To | Carries | Owner (from / to) | SYS | Issue |
|---|---|---|---|---|---|
| IF-1 | web → db/Storage → ingest | Case files, under organisation → project → case | Clemente / Clemente | 1, 2, 16, 24, 27 | #8, #19 |
| IF-2 | ingest → regs | Standardised content blocks stored per case (file, page), plus optional notes | Clemente / Clemente + Ramón | 2, 3, 8, 24, 25, 27, 28 | #4, #19 |
| IF-3 | regs catalogue → requirement writer | Paragraphs with regulation, version, page, paragraph | Ramón / Clemente + Ramón | 5, 6, 15, 23, 25, 28, 29, 32, 34, 43, 44 | #3, #18, #24, #33 |
| IF-4 | agent → db → web, checks | Run output: `submission_main` JSON | Clemente + Ramón / Clemente + Ramón | 4, 14, 25, 29 | #4 |
| IF-5 | Certivity → checks | `validate.py`, `score_local.py`, schemas, `expected.json`, `requirements_old.json` (the regulation list reaches the checks through the library, IF-3) | Clemente + Ramón | 10, 11, 16, 19 | — |
| IF-6 | ops → Certivity platform | Uploads | Clemente + Ramón | 20 | #7 |
| IF-7 | agent → db → web, cap | Model and embedding usage: table `model_usage`, read through `organization_usage_breakdown`, `organization_usage_series` and `organization_month_cost` | Clemente + Ramón / Clemente + Ramón | 40 | #29 |

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
| IF-1 | Storage bucket `case-files` (Vercel rejects bodies over 4.5 MB). Files belong to a case in a project of the organisation (migration `20261024190000_cases.sql`, 84a33a8); `run_files` no longer starts a run (SYS-38, cb8f6b8). A check constraint on media type is the single list of formats | Size limits per file and per run. Purge must empty the bucket. Later: use Ramón's PDF layer (#3) for case PDFs |
| IF-2 | No fixed profile (Certivity could not confirm one). Table `case_file_blocks`: text or image, with file, page and the parser or model that made it, written once at upload; runs read them (`runs.case_id`). Parser first; `INGEST_MODEL` only for what parsers cannot read, marked as a transcription (SYS-27, ADR-0006, 84a33a8) | Whether the writer also gets free-form product notes |
| IF-3 | Catalogue loaded from `index.json` (SYS-23). `regulation` and `version_label` strings are kept exactly as in the file | Query and response shape below ("IF-3 search"): agreed by Ramón on #18, 2026-10-24; Clemente's writer uses it as is (`search_regulations`). Pre-computed or built during the run (`RUN_TIMEOUT_S`, SYS-15). SYS-32 (project chooses its regulations, #24) filters this lookup: agreed by Clemente and Ramón, 2026-10-24. SYS-34: a re-extraction supersedes paragraph rows instead of deleting them (`superseded_at`), readers of the library read current rows only, and requirements are moved to the new row with the same label and `content_hash`: agreed by Clemente and Ramón on #3, 2026-10-24 |
| IF-4 | Output is the Certivity JSON itself, as a typed output, never free text | Source of `team_id` (a setting) and `case_id` |
| IF-5 | Tools and schemas copied unchanged into `agent/certivity/` by `scripts/sync-certivity.sh` (ac791c2); the answer files (`expected.json`, `requirements_old.json`) in table `certivity_reference`, loaded by `make certivity-load`, read by the agent only. Since d1b2c15 the regulation list lives only in the organisation's library (ADR-0006). No bucket. Check results are not stored per run. Both answer formats (main goal and sub-goal) are stored as kind `expected` and told apart by their content (82c8240): one name, two shapes, so a new answer format must not reuse `expected` without a distinguishing field | — |
| IF-6 | 5 valid uploads per hour per challenge. The **last** valid held-out upload counts. Uploads close Sunday 13:00 | Unconfirmed: whether dev-case and held-out uploads share the same quota. Ask Certivity |
| IF-7 | Agreed by Clemente and Ramón on #29, 2026-10-24. One row per model and key per piece of work (run segment, case ingest, index slice), written by `agent_service/metering.py`; process, provider, model as chosen in Admin, key source and hint (last 4, env var name, Ollama URL), tokens, cost estimate (null = unpriced, Ollama $0). Runs from before the table are read from `runs.usage` (migration `20261024300000_model_usage.sql`). The monthly cap sums the same entries | Any new model call (the run chat, #28) must record into it or the page and the cap undercount |

## IF-3 search: query and response shape

Status: **agreed** on 2026-10-24. Ramón, who owns the producer side and shares the consumer side,
agreed in his thread and on #18. Clemente's writer already uses it unchanged: `search_regulations`
in `agent/agent_service/domain/tools.py` calls `regulation_search.search`. Clemente can still
object on #18; a change then needs both owners again.

**Query**, `regulation_search.search(store, http, settings, org, query, *, version_ids, k, mode, case_id)`:

- `org`: the run's organisation. Paragraphs of other organisations are never returned.
- `query`: free text. Full text matches any of its words. Vectors use the first 24,000 characters.
- `version_ids`: the versions to search, or none for the whole library. The writer passes the
  base versions.
- `case_id`: the scope is narrowed further to the regulations the case's project uses (SYS-32,
  agreed on #24).
- `k`: how many results, best first. The writer asks for 20 by default and at most 50.
- `mode`: `hybrid` (default), `text` or `vector`. `hybrid` and `vector` need an embedding key. If
  there is none, `EmbeddingError` is raised and the caller retries with `text`.

**Response**: a list of `Hit`, one per current (not superseded, SYS-34) paragraph:

- `regulation_code`, `version_label`: exactly as in the library, which keeps the `index.json`
  strings (SYS-5).
- `label`: the paragraph label a submission cites (SYS-6). It can be empty for unnumbered text.
- `page_start`, `page_end`: PDF page indices, which equal the footer page (SYS-5).
- `paragraph_id`, `version_id`: what a requirement stores to link to the paragraph (SYS-25).
- `role`, `heading`, `kind`, `text`: for the model to read.
- `score`, `text_rank`, `vector_rank`, `similarity`: why the paragraph came back. A rank is
  empty when that half did not find it.

**What it does not promise:** that a regulation missing from the top k does not apply (SYS-28 says
top-k only picks candidates), or that the vector half covers the whole library. A paragraph has a
vector only after `make regulations-index` or the index endpoint has run since the paragraph was
extracted; until then it is found by words only.

Built in `20261024210000_regulation_search.sql`, filtered to current rows by
`20261024270000_superseded_paragraphs.sql`. Measured on 49,680 synthetic paragraphs: 0.5 to 0.9 s
for the whole library, about 0.1 s for 10 versions (`docs/regulations-store.md`, "As built").
