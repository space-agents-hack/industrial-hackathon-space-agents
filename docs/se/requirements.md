# System requirements

Each requirement: a statement with "shall", its reason, the needs it serves, the part it is
allocated to, how it is verified (see `verification.md`), the issue that implements it, and its
status. Every status below is `proposed` (written by Claude on 2026-10-24, not yet reviewed by
Clemente or Ramón). Owners are on the issues, not here.

Allocation names: **web** (`web/`), **ingest** (case files to case content and case profile,
`agent/`), **regs** (regulation index and requirement extraction, `agent/`), **checks**
(Certivity's `validate.py` and `score_local.py`), **db** (`supabase/`), **ops** (deploy, upload
procedure, people).

Verification methods: **T** automated test, **S** score (`score_local.py` on the dev case or the
platform), **D** demonstration, **I** inspection.

## Input

**SYS-1 Case file formats.** The system shall accept a case as one or more files in .md, .txt,
.pdf, .png, .jpg and .docx.
Why: engineers have the product in whatever form they have it (N-3); the dev case is .md + .png.
Serves N-3. Allocated: web, ingest, db. Verify: T. Issue: none yet (case ingestion design in
progress). Status: proposed.
Open: further formats (.xlsx, .webp, .csv) and the per-file and per-run limits are in the
ingestion design and still `TBD`.

**SYS-2 Nothing dropped silently.** Every accepted file shall reach the model as text or image,
and the run trace shall list each file with what was read and anything skipped or truncated.
Why: a page the model never saw is a requirement nobody finds (N-1), and the engineer cannot tell.
Serves N-1, N-3, N-9. Allocated: ingest. Verify: T. Issue: #8 (to be updated). Status: proposed.

**SYS-3 Case profile.** From the case content, the system shall produce a case profile (product
type, vehicle category, functions, components, with the file and page each claim came from) that
the regulation step consumes.
Why: choosing the applicable regulations is part of the task (README) and needs a structured
description of the product, not raw text. Serves N-1, N-4. Allocated: ingest, regs. Interface:
IF-2. Verify: T (schema), S (regulation-level recall). Issue: none yet. Status: proposed.

## Output

**SYS-4 Submission format.** The output of a main-goal run shall be a JSON document that
`validate.py` accepts, with `team_id` and `case_id` set.
Why: CR1; the platform runs the same check on upload, and a file that fails does not count.
Serves N-7. Allocated: regs, checks. Interface: IF-4. Verify: T. Issue: #4. Status: proposed.

**SYS-5 Citation validity.** Every requirement shall cite a regulation present in
`regulations/index.json`, with the `version_label` of its **base** version, and a page of that
version's PDF.
Why: CR2; a page of the `latest` version counts as a different page (README section 2).
Serves N-2, N-7. Allocated: regs. Verify: T. Issue: #3, #4. Status: proposed.

**SYS-6 Paragraph.** Every requirement shall also cite the paragraph label.
Why: a page counts if the page or the paragraph is right (README, "How it is judged"), so the
paragraph protects against an off-by-one page. Serves N-2, N-1. Allocated: regs. Verify: T.
Issue: #3. Status: proposed.

**SYS-7 One obligation per requirement.** Each requirement shall state one engineering
obligation (one scope, condition and constraint).
Why: requirements are matched one to one; merging two loses recall (Brief 07). Serves N-4, N-5,
N-1. Allocated: regs. Verify: S (requirement level on the platform), I. Issue: #4. Status:
proposed.

**SYS-8 Recall and precision on the dev case.** On `dev-rear-lamp`, regulation-level recall shall
be at least `TBD` and page-level recall at least `TBD`, measured with `score_local.py`.
Why: F2 weights recall over precision (Brief 07). Targets are set from the first baseline score,
not before (SOUL.md: no invented numbers). Serves N-1, N-4. Allocated: ingest, regs. Verify: S.
Issue: #4. Status: proposed.

**SYS-9 Test case.** Each requirement should carry a test case. ("Should": optional in the
schema, not scored as far as the README says.)
Serves N-5. Allocated: regs. Verify: I. Issue: none yet. Status: proposed.

## Checks on our side

**SYS-10 Validate on every run.** When a run produces a submission, the system shall run
`validate.py`, unchanged from Certivity's copy, and show the result with each problem's JSON path.
Why: catching an invalid file before upload saves one of 5 uploads per hour. Serves N-7.
Allocated: checks, web. Interface: IF-5. Verify: T. Issue: none yet (validate/score design in
progress). Status: proposed.

**SYS-11 Local score where an answer exists.** For a case with an expected answer (only the dev
case), the system shall show `score_local.py`'s regulation and page scores.
Why: the only offline measure we have. Serves N-1, N-12. Allocated: checks, web. Interface: IF-5.
Verify: D. Issue: none yet. Status: proposed.

## Review, demo, deployability

**SYS-12 Source link.** In the web, each requirement shall link to its source page of the
regulation PDF.
Why: Brief 07 names it under the UI criterion. Serves N-2. Allocated: web. Verify: D. Issue: #6.
Status: proposed.

**SYS-13 Approval before export.** Exporting or submitting the requirements shall be a tool
marked `requires_approval=True`, so a person approves before anything leaves the system.
Why: AGENTS.md rule for writes, and the deployability story. Serves N-9. Allocated: regs, web.
Verify: T (the run pauses before it). Issue: #6. Status: proposed.

**SYS-14 End to end in one flow.** From uploading case files to a validated submission shall need
no manual step.
Serves N-8. Allocated: web, ingest, regs, checks. Verify: D. Issue: #4. Status: proposed.

**SYS-15 Run time.** A full run shall finish inside the agent's run limit, today
`RUN_TIMEOUT_S` = 270 s in one HTTP request (`docs/architecture.md`).
Why: a run that times out produces nothing. Not measured yet; writing every cited requirement of a
case in one request may not fit. If it does not fit,
this requirement changes the architecture (pre-computed index, or the container in
`agent/Dockerfile`), not only the prompt. Serves N-8. Allocated: regs, ingest, ops. Verify: T
(timed real run). Issue: none yet. Status: proposed.

**SYS-16 Confidential inputs.** Case files and Certivity data shall never be committed, and shall
be deletable by `scripts/purge-challenge-data.sh`, including Storage objects.
Why: AGENTS.md limits, LICENSE-DATA.md ("hackathon only"), and N-9. The script deletes database
rows only today; it does not empty Storage buckets. Serves N-9. Allocated: db, ops. Verify: I, T.
Issue: none yet. Status: proposed.

**SYS-17 Record of the run.** Every model message, tool call, check result and approval shall be
recorded in the run trace (`run_events`).
Why: an auditor or an engineer must be able to see why a requirement is on the list. Already true
for the template's loop. Serves N-9, N-12. Allocated: regs, db. Verify: T. Issue: none. Status:
proposed.

**SYS-18 Export to requirements tools.** The system may export requirements in a format
importable by Polarion or Jama (for example ReqIF or CSV). ("May": not graded.)
Serves N-10. Allocated: web. Verify: D. Issue: none. Status: proposed.

## Sub-goal

**SYS-19 Change detection.** Given the old requirements and the base and latest versions of a
regulation, the system shall produce a sub-goal file that `validate.py --requirements-old`
accepts, flagging each requirement as modified, removed or added with the reason in the
regulation.
Serves N-6, N-7. Allocated: regs, checks. Verify: T, S. Issue: #5. Status: proposed.

## Operations at the event

**SYS-20 Held-out submission.** The final valid upload for `heldout-front-bumper` shall be the
best-scoring file we have, uploaded before Sunday 13:00, following the procedure in
`docs/hackathon.md`.
Why: the last valid upload counts, not the best (README section 5); uploads close at 13:00 (Brief
08). Serves N-7. Allocated: ops. Verify: I (upload log on #7). Issue: #7. Status: proposed.

**SYS-21 Organisers' submission.** Repository, demo and answers shall be on the organisers'
platform before their deadline. Serves N-11. Allocated: ops. Verify: I. Issue: none yet.
Status: proposed.

**SYS-22 Measured weakness.** The pitch shall state the measured scores and where the system is
weak, from our own measurements. Serves N-12. Allocated: ops. Verify: I. Issue: none yet.
Status: proposed.

## Needs without a requirement yet

None. Every N- in `stakeholders.md` has at least one SYS-.
