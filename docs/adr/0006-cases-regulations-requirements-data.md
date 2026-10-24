# ADR-0006: Projects, cases and requirements live in the database, each requirement linked to one regulation paragraph

**Status:** Accepted (Clemente, 2026-10-24). The regulation library is Ramón's design
(`docs/regulations-store.md`, built in 4cf1d99).
**Date:** 2026-10-24
**Deciders:** Clemente (cases, requirements), Ramón (regulation library)

## Context

The product has three steps: an engineer gives a case in whatever form they have it (SYS-1);
the regulations come in from an `index.json` and are split into paragraphs with pages (SYS-23);
an agent writes the requirements that apply to the case, each traced to a regulation paragraph
(SYS-25). Clemente (2026-10-24): case data "shall be DB" (SYS-24).

What `main` did when this was written (96f36c3 to 46e3f43):

- A case was not a record. Files hung off a run (`run_files.run_id not null`) and were parsed
  again on every run. The parsed content was stored nowhere, except inside the saved
  conversation (`run_state`, images as base64) when a run paused.
- Requirements were not records either: a run's result is the text column `runs.output`.
- The agent was still the template's ECN triage (prompt, `plm_*` tools, output `str`).
- The regulation import existed (4cf1d99) with one library per organisation. Paragraphs and
  embeddings were designed but not built.
- The regulation list was in the database twice: `certivity_reference` (Certivity's index, read
  by `validate.py`) and the library (`regulations`, `regulation_versions`, what we cite from).

Measured on the dev case (base PDFs, pypdf): its four regulations are 372 pages, about 200k to
226k tokens together (R48 alone about 85k). The 190 expected requirements fall on 53 distinct
pages; 25 of their paragraph labels are annex or table labels, not plain numbers.

## Decision

**Hierarchy.** Organisation → project → case → requirement. Every member of the organisation
reads and works on its projects and cases. A project groups the cases of one product, for
example one part of a car. Roles are those of ADR-0004: viewers read, members and admins write.

**Case side** (all organisation-owned, row-level security as for `runs`):

- `projects`: `organization_id, name, created_by`, unique per organisation.
- `cases`: `project_id, organization_id` (repeated so the read policy needs no join), `name,
  created_by`, unique per project.
- `case_files`: one row per uploaded file, with a parse status (`pending`, `parsed`, `failed`)
  and its error. Storage path `{organization_id}/{case_id}/...` in the existing private
  `case-files` bucket. Same format check as `run_files`.
- `case_file_blocks`: the standardised content: `file_id, seq, kind ('text' | 'image'), page,
  label, text, image_path, parser` (`pypdf`, `python-docx`, ... or `model:<id>`).
- `runs.case_id`, nullable so runs from before stay valid. `run_files` stays for those runs and
  is no longer written.

**Ingestion.** Parse first, with the deterministic readers in `domain/ingest.py`. A file or
page the parser fails on or does not recognise goes to a model. Both produce the same
`case_file_blocks`, and `parser` says which one did. The model handles content, not new formats:
the format allowlist stays, and a refused format is still refused with a message. A case is ingested once, when its files are
uploaded, not on every run. Why parser first: a parser cannot lose the page a sentence came from
or paraphrase a limit, and it is tested per format; a model is the fallback for what it cannot
read (scans, drawings, unknown layouts), and its output is marked as such.

**Requirements.** `requirements`: `case_id, run_id, organization_id, ext_id ('R-001'), text,
test_case, paragraph_id not null, regulation, version_label, page, paragraph, status ('draft' |
'approved')`. Each requirement is linked to exactly one regulation paragraph (Clemente,
2026-10-24), which is also what a Certivity submission cites. The four citation columns are
copied by code from the paragraph row, never typed by the model, so SYS-5 and SYS-6 hold by
construction; they are kept on the row because they are what Certivity scores, and a test
asserts they still equal the paragraph's. An obligation that two regulations impose is two
requirements; the dev answer key does exactly that for 2 of its 188 distinct texts. The submission JSON is assembled from the rows and checked with
`validate.py`.

**Regulation library.** As built and designed by Ramón: per organisation, `regulations`,
`regulation_versions`, the private `regulations` bucket, and (to build) `paragraphs` with
`label` ("Annex 3 Part 2 1.2", exactly as Certivity writes it), `page_start`, `page_end`, and
`embeddings` keyed by `(content_hash, model)`.

**One regulation list.** The library is the only place the list of citable regulations lives
(Clemente, 2026-10-24: one `index.json`, imported once). The Certivity checks build the list
`validate.py` needs from the organisation's library: it reads only each regulation's name and its
versions' `version_label` and `role`, which `regulations` and `regulation_versions` hold.
`certivity_reference` keeps only Certivity's answer keys (`expected`, `requirements_old`), which
are scoring data, not regulations, and stops holding the index.

**Where each step runs.**

| Step | Trigger | Runs on |
|---|---|---|
| Case upload | browser, as the user | Storage |
| Case ingestion | after upload | agent, own request (800 s) |
| Regulation import | admin uploads `index.json` in the app | agent, in slices |
| Regulation extraction, embeddings | to decide on #3 | never inside a requirement run |
| Requirement run | "Start run" on a case | agent, `RUN_TIMEOUT_S` 770 s |

## Options considered

### Case as its own record (chosen) or files on the run

| | Case record | Files on the run |
|---|---|---|
| Rerun a case with another model or prompt | Yes, no re-upload | Re-upload each time |
| Trace a requirement to the case page | `case_file_blocks` | Only inside one conversation |
| Several people on one case | Yes | One person's run |
| SYS-24 | Met | Not met |

### Ingestion: parser with model fallback (chosen), model only, or parser only

Model only reads everything but can drop or reword what it read, and costs a call per file on
every case. Parser only cannot read scans or drawings, and the trace would show them as skipped.
Parser with fallback keeps exact text where it can and still reads the rest.

### Regulation library: per organisation (Ramón, built) or shared

A shared catalogue stores the UNECE PDFs once. Per organisation lets two clients cite different
versions and keeps a client's own set private, at the cost of one copy per organisation (214 MB
for the challenge's set). Per organisation was chosen; N-13 is met per organisation.

### Writer input: exhaustive reading (chosen) or top-k retrieval

F2 counts a missed requirement four times as heavily as an extra one, and top-k retrieval can
only miss. The writer reads each chosen regulation in full, in paragraph-aligned windows, in
parallel (`design/requirements-writer.md` in the project files). Embeddings and full-text search
choose among the 56 regulations, back up that choice, and serve tracing and the UI.

## Consequences

- Easier: rerunning and comparing cases; linking each requirement to its page (SYS-12); the
  sub-goal finds the requirements a changed paragraph affects through `paragraph_id` (SYS-19); purging is deleting rows and bucket objects.
- Harder: the web form changes from "files for this run" to "project, case, then run"; one more
  migration after #8 was released.
- The reason for one list: until this ADR the list was in `certivity_reference` and in the
  library, loaded by two steps (`make certivity-load` or the release, and the app's import). If
  only one were reloaded when the held-out case brings new PDFs on Sunday, a citation could pass
  our check and fail the platform, with nothing failing before. With one list, Sunday is one
  import in the app.
- Revisit: whether parallel writer calls fit in one 770 s request (#14). Fallback: the
  `agent/Dockerfile` container on the Pi or the VPS.

## What this does not do

- No per-user or per-project permissions inside an organisation: every member sees every
  project. Add them if a client asks.
- No regulation catalogue shared between organisations.
- No geometry from CAD files: STEP and IGES give names and structure only (SYS-1).

## Action items

1. Migration and ingest changes for projects, cases, case files and case blocks (SYS-24, IF-1,
   IF-2).
2. `requirements`, and the submission assembled from rows (SYS-25, IF-4, #4).
3. Paragraph extraction and embeddings (SYS-23, IF-3, #3).
4. Checks read the regulation list from the library; drop the `index` row and its loading from
   `certivity_reference` (SYS-5, SYS-10, IF-5).
5. Purge both buckets and the new tables (#16).
