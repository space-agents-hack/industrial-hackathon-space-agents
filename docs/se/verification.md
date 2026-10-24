# Verification

How each requirement is shown to be met. A requirement is
`verified` only when the evidence column links to something a person can open: a test, a CI run,
a recorded score, a demo note. Nothing here is verified yet (2026-10-24).

Methods: **T** automated test in `make check`, **S** score, **D** demonstration, **I** inspection.

| V | SYS | Method and pass criterion | Evidence |
|---|---|---|---|
| V-1 | SYS-1 | T: one fixture per format (CAD included) reaches ingest; a refused format gives a clear message | none yet |
| V-2 | SYS-2 | T: trace has one event per file, with pages read and anything skipped | none yet |
| V-3 | SYS-3 | T: every content block carries file and page; S: regulation-level recall | none yet |
| V-4 | SYS-4 | T: a run's output passes the vendored `validate.py` | none yet |
| V-5 | SYS-5 | T: every cited regulation and version label is in `index.json` exactly, version is `base` | none yet |
| V-6 | SYS-6 | T: no requirement without a paragraph | none yet |
| V-7 | SYS-7 | S: requirement-level precision and recall on the platform; I: sample of 20 read by a person | none yet |
| V-8 | SYS-8 | S: `score_local.py` on `dev-rear-lamp` meets the targets, once set | none yet |
| V-9 | SYS-9 | I: share of requirements with a test case | none yet |
| V-10 | SYS-10 | T: an invalid output shows its problems with JSON paths | none yet |
| V-11 | SYS-11 | D: dev-case run shows regulation and page scores; held-out run shows "no local score" | none yet |
| V-12 | SYS-12 | D: a click on a requirement opens the cited page | none yet |
| V-13 | SYS-13 | T: the run pauses once before export and one approval releases the whole list | none yet |
| V-14 | SYS-14 | D: production run from upload to validated file, no manual step, timed | none yet |
| V-15 | SYS-15 | T: timed real run on the dev case, under `RUN_TIMEOUT_S`, with the time recorded | none yet |
| V-16 | SYS-16 | I: `git ls-files` has no case files and no Certivity data (test_no_certivity_data_is_in_the_repository); T: purge empties tables, `certivity_reference` included, and the `case-files` bucket | none yet |
| V-17 | SYS-17 | T: runner test with the in-memory fake records every step | template tests (to recheck) |
| V-18 | SYS-18 | D: exported file imports into a requirements tool | none yet |
| V-19 | SYS-19 | T: sub-goal file passes `validate.py --requirements-old`; S: platform sub-goal score | `agent/tests/test_regdiff.py` (schema); dev file passed `validate.py`, local score in the log below; platform score not yet |
| V-20 | SYS-20 | I: upload log on #7, last upload = best file, before 13:00 | none yet |
| V-21 | SYS-21 | I: confirmation from the organisers' platform | none yet |
| V-22 | SYS-22 | I: pitch slide numbers match the recorded scores | none yet |
| V-23 | SYS-23 | T: a small index ingests end to end, embeddings included; I: rows per regulation match the index | without embeddings: `agent/tests/test_library_integration.py` (import, split, full-text search on a local stack), `supabase/tests/regulation_paragraphs_test.sql`; citation check in the log below |
| V-24 | SYS-24 | T (pgTAP): two members of one organisation both read and write its projects and cases; a member of another organisation reads none of its projects, cases, files or requirements; I: `git ls-files` has no case data | none yet |
| V-27 | SYS-27 | T: a fixture the parser cannot read goes to the (fake) model, and both paths store blocks of the same schema with file and page | none yet |
| V-25 | SYS-25 | T: every stored requirement points to exactly one existing catalogue paragraph whose regulation, version and page match its citation; S: requirement-level score | none yet |
| V-28 | SYS-28 | T: with a fake index, the regulations returned by top-k are then read in full (all their paragraphs reach the writer); S: regulation-level recall on the dev case | none yet |
| V-29 | SYS-29 | T: a requirement citing a paragraph that is not in the DB, or a duplicate, is caught by the check agent before output; a paragraph with "shall" in a selected regulation that no requirement cites is listed | none yet |
| V-30 | SYS-30 | D: one dev-case run with a local model (future) | none yet |
| V-31 | SYS-31 | D: a second member renames a case, removes a file and opens its parsed pages | none yet |
| V-32 | SYS-32 | T: a project limited to some regulations gives the writer only those; a new import reaches an "all" project | none yet |
| V-33 | SYS-33 | T: the model set per process by the admin is the one each agent uses, and a per-run override wins for writer and check | none yet |
| V-26 | SYS-26 | D: a generated `index.json` passes the same loader as Certivity's (future) | none yet |

## Score log

Every score we measure goes here, so the pitch (SYS-22) only uses numbers we recorded. One line
per measurement: date and time, case, commit, model, regulation / page / requirement precision
and recall, who ran it. Platform scores for the held-out case also go on issue #7.

| When | Case | Commit | Model | Scores | By |
|---|---|---|---|---|---|
| 2026-10-24 16:30 | dev-rear-lamp, subgoal-dev | this commit (#3) | none (`paragraphs.py`, rules only) | paragraph split: every cited (regulation, version, paragraph) found with its page in range, 119/121 dev (2 misses cite a table name), 117/117 sub-goal | Claude for Ramón |
| 2026-10-24 16:20 | subgoal-dev | 3fb3f40 | none (`regdiff`, rules only) | local sub-goal scorer in `regdiff.score`: flagged 7/7, extra 0, change type 7/7; added 16/17, extra 0 | Claude for Ramón |
