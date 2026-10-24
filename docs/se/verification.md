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
| V-30 | SYS-30 | T: `supabase/tests/ollama_provider_test.sql` (URL visible, secret only to the agent), agent tests for the headers a proxy sees and for ingestion not using a hosted model; D: one dev-case run with a local model | T in `make check`; D none yet |
| V-31 | SYS-31 | D: a second member renames a case, removes a file and opens its parsed pages | none yet |
| V-32 | SYS-32 | T: a project limited to some regulations gives the writer only those; a new import reaches an "all" project | none yet |
| V-33 | SYS-33 | T: the model set per process by the admin is the one each agent uses, and a per-run override wins for writer and check | none yet |
| V-34 | SYS-34 | T (pgTAP): after re-extracting a regulation version, every requirement's paragraph link is set and points to an existing row; the old rows are still there, marked superseded; an unchanged paragraph's requirements point to the new row; a changed or missing one's requirements are marked for re-check and the check agent re-runs on them | Partial: `supabase/tests/regulation_paragraphs_test.sql` (old rows kept, superseded; search and embedding keys skip them) and `supabase/tests/requirements_test.sql` (unchanged text moves to the new row, changed text keeps the superseded row and is flagged with `paragraph_superseded_at`; the purge keeps only cited rows). Not covered: re-running the check agent on its own |
| V-35 | SYS-35 | T (pgTAP): a join request gives no access until an admin of that organisation approves it; a declined or pending person reads none of its rows; an admin of another organisation cannot approve it; a new-organisation request gives nothing until a platform admin approves it, then makes the requester its admin | `supabase/tests/access_requests_test.sql` (20 assertions, 03c802d); CI on the local stack |
| V-36 | SYS-36 | T: navigation rules, no project selected shows only project choice or creation, and Runs, Regulations, Changes and Checks only appear with a project; D: sign in, pick a project, see its sections | T: `web/lib/navigation.test.ts` (3990023); D none yet |
| V-37 | SYS-37 | T: Settings is hidden from and refused to a non-admin member; deployment-wide parts are hidden from and refused to an organisation admin who is not a platform admin | T: hidden for non-admins `web/lib/access.test.ts` (showsAdmin); deployment tabs only for platform admins `web/lib/navigation.test.ts` (267709d); writes refused `supabase/tests/rls_test.sql`, `deployment_test.sql`. Gap: no test opens an admin page as a member and sees it refuse |
| V-38 | SYS-38 | T: a run for a case without files, or in a project with no regulation, or with no case, is refused with its reason | `web/lib/run-readiness.test.ts` (cb8f6b8) |
| V-39 | SYS-39 | T: with the scripted model, "why R-n" quotes the cited paragraph from the library, "is X captured" names the requirement that cites the paragraph or says none does; the run's model and the organisation's key are used and the key never reaches the answer; over the cap it refuses; nothing is written | `agent/tests/test_run_chat.py`, real schema in `test_store_integration.py`, request shapes in `web/lib/run-chat.test.ts`. Gap: not run with a real model yet; viewers refused only by the route (`actsInRunOrganization`), no test opens the route as a viewer |
| V-41 | SYS-41 | T (pgTAP): an admin adds an existing account by email with a role and no password, cannot add to or remove from another organisation, cannot remove the last active admin; a removed person keeps their other memberships; an organisation admin searches only people of organisations they manage; a platform admin creates an organisation with an existing account as admin, and a typo creates nothing | `supabase/tests/membership_management_test.sql`; request bodies `web/lib/admin.test.ts` |
| V-42 | SYS-42 | I: every change to the prompt, the writer and its filters is read for names of regulations, paragraphs or pages and for tuning against `expected.json`; S: the held-out score is not far below the dev score | none yet |
| V-26 | SYS-26 | D: a generated `index.json` passes the same loader as Certivity's (future) | none yet |

## Score log

Every score we measure goes here, so the pitch (SYS-22) only uses numbers we recorded. One line
per measurement: date and time, case, commit, model, regulation / page / requirement precision
and recall, who ran it. Platform scores for the held-out case also go on issue #7.

| When | Case | Commit | Model | Scores | By |
|---|---|---|---|---|---|
| 2026-10-24 19:07 UTC | dev-rear-lamp (platform) | not given | not given | valid; 462 requirements; regulations P 0.500 R 0.750 F2 0.682; pages P 0.369 R 0.849 F2 0.674 | Clemente |
| 2026-10-24 16:30 | dev-rear-lamp, subgoal-dev | this commit (#3) | none (`paragraphs.py`, rules only) | paragraph split: every cited (regulation, version, paragraph) found with its page in range, 119/121 dev (2 misses cite a table name), 117/117 sub-goal | Claude for Ramón |
| 2026-10-24 16:20 | subgoal-dev | 3fb3f40 | none (`regdiff`, rules only) | local sub-goal scorer in `regdiff.score`: flagged 7/7, extra 0, change type 7/7; added 16/17, extra 0 | Claude for Ramón |
