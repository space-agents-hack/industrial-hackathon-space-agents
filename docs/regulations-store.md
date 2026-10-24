# Regulations store: proposal

Status: the import, the split into paragraphs with pages and full-text search are built (see
"Importing from the app" and "Extraction" below), and so are embeddings, scope summaries and the
hybrid search (see "As built" under Search). How the UN Regulation
PDFs get into Supabase so the agent can match a component description to the paragraphs that apply,
and cite them the way the challenge scores them.

## What the data and the scoring force

Checked on this machine on 2026-10-24, not assumed:

- **92 PDFs, 56 regulations** (55 UN R plus GTR 9), 36 with base and latest, 20 base only.
  5,496 pages, about 2.26 million words (`pdftotext`), so roughly 3 million tokens.
- **The PDFs have a real text layer.** All 92 were rendered by headless Chrome and every one
  carries a footer `UN Rxx, version X.Y.Z | page n of N`. Text extraction gives exact text and
  exact pages. **OCR is not needed for the text**, only possibly for text inside figures.
- **The page that is scored is the PDF page index**, and it equals the `n` in that footer
  (checked on R148). The two meanings of "page" coincide here; the store keeps the PDF index.
- **The submission's `version` is the version label** (e.g. `7.3.0`), not "base"/"latest". The
  label is in `index.json` and in every page footer. "base"/"latest" are only positions in the
  challenge index.
- **Paragraph labels include annex and part.** Numbering restarts inside each annex, so `1.2`
  alone is ambiguous; a label has to read like `Annex 3 Part 2 1.2`. Tables are cited as a
  paragraph plus the table name.
- **A paragraph can span pages.** The platform scores the full page range of a paragraph, so each
  stored paragraph needs `page_start` and `page_end`.
- **Scale:** about 49,000 numbered paragraph lines over both versions (some are false positives
  from tables), and about 4,200 embedded images (`pdfimages`, includes masks and repeats).
- **This machine has no GPU** (8 cores, 31 GB RAM). That decides where embeddings are computed.

## Layers

| Layer | Where | Holds |
|---|---|---|
| Originals and derived files | Storage bucket `regulations`, private | PDF, Markdown, extraction JSON, pictures |
| Corpus | Postgres tables | regulations, versions, paragraphs with pages |
| Search | Same tables | full-text (`tsvector` + GIN) and `pgvector` |

One database for all three: about 50,000 paragraphs is small for Postgres, and keeping vectors next
to the paragraphs lets one SQL query filter by regulation and version and rank by text and meaning.
A separate vector database would be a second copy to keep in sync, for no gain at this size.

## Bucket

```
regulations/
  <organization_id>/
    UN_R10/
      7.2.0/
        UN_R10_7.2.0.pdf
        UN_R10_7.2.0.md       extracted text, with <!-- page n --> markers (not built; the
                              paragraphs are in the database instead, see "Extraction")
        UN_R10_7.2.0.json     (not built, same reason)
        images/
          p0012_01.png        page 12, first picture (not built yet)
      7.3.0/
        ...same shape
```

**Folders by version label, not by role.** The first proposal used `base/` and `latest/` folders.
Once imports run from the app, a new index can make 7.4.0 the "latest": with role folders it would
overwrite the file that the 7.3.0 row still points to, silently. With version folders every stored
file keeps its path forever, and the role is a column (`regulation_versions.role`) that moves to the
newer version in the same transaction that records it.

**Pictures fit easily.** Measured with `pdfimages -all`: 4,156 images, 114 MB in total, of which
2,443 are distinct (67 MB) and about 1,100 are under 2 KB. Most are approval-mark examples, test
grids and schematic diagrams. Keep each image in its original encoding and upload each distinct
image once. With 214 MB of PDFs, the bucket stays around 300 MB of the free plan's 1 GB.

## Tables

`regulations` and `regulation_versions` are built (`20261024180000_regulations.sql`), and so is
`regulation_paragraphs` (`20261024200000_regulation_paragraphs.sql`, below) and the search tables
(`20261024210000_regulation_search.sql`). The rows not marked BUILT are still the proposal.

```
regulations            one row per regulation (56)
  id, code 'UN R10', slug 'UN_R10', kind 'UN R' | 'GTR', title, source_url

regulation_versions    one row per PDF (92)
  id, regulation_id, role 'base' | 'latest', version_label '7.3.0', status, sha256,
  size_bytes, page_count, pdf_path, md_path, json_path,
  scope_summary, keywords text[], summary_model,          -- AI, see below
  extracted_at, pipeline_version
  unique (regulation_id, version_label)

regulation_paragraphs  one row per paragraph (48,487 for the challenge's 92 PDFs)       BUILT
  id, version_id, organization_id, position,
  label 'Annex 3 Part 2 1.2'                              -- what the submission cites
  annex, appendix, part, number, heading, kind 'paragraph' | 'text',
  text, page_start, page_end, content_hash (sha256 of text),
  context,                                                -- AI, see below; nothing writes it yet
  fts tsvector generated from label (A) + heading and context (B) + text (C), English, GIN
regulation_versions gets extracted_with, extraction_error, paragraph_count            BUILT

paragraph_images       one row per kept picture
  id, version_id, paragraph_id null, page, path, caption, sha256

regulation_embeddings  one row per distinct embedded input, organisation and model       BUILT
  organization_id, model 'openai:text-embedding-3-small@1024', input_sha256,
  embedding halfvec(1024)
regulation_paragraph_keys  paragraph_id -> input_sha256, refreshed by the indexer      BUILT
regulation_versions gets scope_summary, scope_keywords, summary_model, summary_sha256,
  summarized_at                                                                       BUILT
```

`regulation_embeddings` is keyed by the hash of the input, not by paragraph: most paragraphs are
identical in base and latest, so each distinct text is embedded once. It also lets a new model be
added beside the old one. Why the key is not `content_hash`: "As built" under Search.

## Importing from the app

**Each organisation has its own library** (Ramón, 2026-10-24). What an admin imports, everyone in
the same organisation sees when they sign in; other organisations do not. Two clients may cite
different sets or versions, and a client's set may not be public. The cost is one copy of the PDFs
per organisation (214 MB for the challenge's set). Every table row carries `organization_id`, and the
bucket path starts with it, so the same rules as for case files decide who reads what.

An admin of the organisation (or a platform admin) opens **Regulations** in the web app and uploads
an index file in the challenge's `regulations/index.json` format. The rest is automatic:

1. The web stores the file as a `regulation_imports` row (`create_regulation_import`, which checks
   the role, refuses a second import while one is active, and writes the audit row) and calls the
   agent.
2. The agent checks every entry (`agent/agent_service/domain/regulations.py`) and writes one
   `regulation_import_files` row per PDF. An index with mistakes fails with the list of them.
3. For each file: if the library already has this version with the same sha256, it is marked
   `unchanged` and not downloaded. Otherwise it is downloaded (https only, public addresses only, no
   redirects, at most 50 MB), checked against its sha256 and the `%PDF-` header, uploaded to the
   bucket, and recorded with `record_regulation_version`.
4. One agent request works for `import_slice_s` (150 s), then leaves the import `paused`. The page,
   while open, sends it back for the next slice. Measured locally on 2026-10-24: the challenge's 92
   PDFs (214 MB) were stored in under a minute, in one slice; importing the same file again
   downloaded nothing.

Everyone in the organisation sees its library on the same page and opens a PDF through a signed
link valid for one hour.

What the import does not do: delete anything (a version missing from a new index stays), continue
while no import page is open (it waits, paused, and Resume picks it up), or store more than one PDF
per version.

## The two AI fields

**Per version: a scope summary and keywords. Yes.** Matching a component to regulations starts with
"which regulations apply to a rear lamp at all". With 92 versions, every summary fits in one prompt
(92 x 150 words is about 14,000 words), so the agent can read all of them instead of searching. That
is the highest-value AI field in the store and costs 92 model calls. Keywords help the full-text
search find the regulation from vocabulary the regulation itself does not use.

**Per paragraph: one generated context line instead of keywords.** A paragraph like "shall not
exceed 30 cd" says nothing about what it applies to; the context lives in its headings. A short
generated line ("R7, rear position lamps, photometric limits") prepended before embedding and indexed
in full-text fixes that. Free-form keywords per paragraph would be a weaker version of the same thing,
and invented keywords create false matches that are hard to spot. Cost: one call per distinct text,
on the order of 30,000 to 50,000 calls, so a small, cheap model and only if the pilot shows
headings alone are not enough.

## Embeddings

- **Hosted model, not local**, because there is no GPU here. The text is about 3 million tokens; at
  the price I remember for OpenAI `text-embedding-3-small` (USD 0.02 per million tokens, not
  checked today) that is well under a dollar and minutes, against an unmeasured number of hours for
  BGE-M3 on 8 CPU cores.
- **Provider: OpenAI directly.** DeepSeek's API documentation lists chat and search but no
  embeddings endpoint (checked 2026-10-24). OpenRouter does offer embeddings, including the same
  `openai/text-embedding-3-small`, but it is one more company in the path of the specification text
  for the same model. OpenRouter is the fallback if the team only has an OpenRouter key. The same
  model through either route should give compatible vectors (inferred, not tested). Whichever is
  used, the `model` column records it, and documents and queries must use the same one.
- **1,024 dimensions as `halfvec`**, about 2 KB per row. Full 1,536-dimension float vectors would be
  about 6 KB per row, roughly 300 MB for 50,000 rows. The project is on the free plan, whose
  database limit is 500 MB (from memory, not checked against the dashboard): vectors would take most of it.
- **No ANN index at first.** Exact search over 50,000 rows filtered by version is fast enough, and
  approximate indexes can return too few rows when combined with filters. Add HNSW only if a
  measurement says it is slow.
- **Query side:** the specification text goes to the embedding provider at query time. It already
  goes to the model provider; the data notice allows use for the hackathon, but it is one more
  provider holding it.

## Search

One SQL function, called by the agent through read-only tools:

```
match_paragraphs(query_text, query_embedding, version_ids[], k)
  full-text candidates + vector candidates, merged by reciprocal rank fusion
```

Agent tools, all read-only so none needs approval:

- `list_regulations`: every version with its scope summary, to pick candidates.
- `search_paragraphs`: the function above, limited to the chosen versions.
- `get_paragraph`: one paragraph with its parent, children, pages and pictures.

The model reads the top results itself; that is the reranking step. A separate cross-encoder is
deferred until the pilot shows the model is drowning in bad candidates.

### As built (migration `20261024210000_regulation_search.sql`, issue #18)

What changed from the proposal above, and why:

- **Two hashes with two names.** `regulation_paragraphs.content_hash` is the sha256 of the paragraph
  text alone, which the version diff needs. A vector depends on more than that: the input is the
  regulation code and title, the heading breadcrumb, the AI context line when there is one, and the
  text (`regulation_embedding_input`). Its key is `input_sha256`, in `regulation_embeddings`
  `(organization_id, model, input_sha256)`. Base and latest still share a vector when the paragraph
  is unchanged.
- **The key is stored per paragraph** (`regulation_paragraph_keys`), not computed at search time.
  Computing it in the query took 7.9 s for a search over 50,000 paragraphs, and one plan did not
  finish in ten minutes. `refresh_regulation_embedding_keys` brings the keys up to date and the
  indexer runs it at the start of every slice. Until it runs, a new paragraph is found by full text
  only.
- **Vectors per organisation**, like everything else in the library (SYS-24), so deleting an
  organisation deletes them.
- **`model` records provider, model and length** (`openai:text-embedding-3-small@1024`): vectors from
  OpenAI and OpenRouter are never compared until someone checks that they match.
- **Full text matches any word of the query**, ranked with `ts_rank`. A specification passage has
  dozens of words and requiring all of them would match nothing. `ts_rank_cd` was nine times slower.

Measured on 2026-10-24 on a local Postgres 16 with pgvector 0.8, with 49,680 synthetic paragraphs over
92 versions (34,776 distinct texts) and random vectors. The text was synthetic, so these numbers are
about speed and size only, not about how good the results are:

| What | Result |
|---|---|
| Vectors with their keys | 101 MB |
| Search over the whole library | 0.5 to 0.9 s |
| Search over 10 versions | 0.1 to 0.2 s |
| Refreshing every key, first time | 3.1 s |
| The same 10-version search before the tables had statistics | over 30 s, once 6 minutes |

Two things the speed depends on. The search is a plpgsql function planned with the real
organisation and versions on every call: planned once with placeholders, the same query took
minutes. And the planner needs statistics on freshly written tables: the indexer calls
`analyze_regulation_search` after it writes keys or vectors, rather than waiting for autovacuum.

With the extraction's 68 MB for the paragraphs, a library takes about 170 MB of the free plan's
500 MB. A second organisation with the same library takes another 170 MB.

How to run it: the Regulations page starts the indexer by itself once an import has added
paragraphs the indexer has not seen, and an admin can start it with **Index library** (#37). Like an
import, it runs one slice per request (`POST /regulations/index/{organization_id}/advance`, through
the web's `POST /api/regulations/index`) only while the page is open, and stops when a slice writes
nothing: a missing key or summary model would otherwise loop forever. The page shows, per version,
how many paragraphs have a vector of the model searches use (`regulation_index_status`, migration
`20261024320000_index_status.sql`) and the scope summary with the model that wrote it.
`make regulations-index` does the same from a terminal against the database in `agent/.env`.
Paragraph keys are added 1,000 per call (`add_regulation_embedding_keys`, #41): the first version
hashed the whole library in one statement, about 25 s for 48,487 paragraphs on the hosted database
(measured 2026-10-24), which cancels any statement after 8 s, so production could not be indexed
at all. A key made stale by a change of a regulation's title is not rebuilt by the batches.
`make regulations-search Q="..." MODE=text|vector|hybrid` shows what a query finds. That is also
how to compare full text, vectors and both on the dev case.

Why the trigger exists: until #37 nothing called the endpoint, and production ran with 48,487
paragraphs, no vector and no summary (2026-10-24, 19:21 UTC). Every search matched words only and
every regulation reached the agent with `scope: null`, and nothing said so. A search that matches
words only now says it, in the run's trace and under the assistant's answer.

Scope summaries read the first 8 pages of each PDF (title, contents, scope) with the
organisation's summary model (Admin, Models), else `SUMMARY_MODEL`, which defaults to Haiku. It
used to fall back to `AGENT_MODEL`, Opus in production: about $3.50 for 92 summaries instead of
about $0.44 (an estimate from 0.7M input tokens, not measured). A model that refuses (no key)
stops the summaries with one note instead of failing the slice. `summary_sha256` records which PDF a summary
came from, so a new PDF under the same label gets a new summary. The keywords are for the agent to
read. They are not in the full-text index, because that index belongs to the paragraphs table and
the keywords belong to a version.

Not built yet: recall measured on the dev case; indexing without a browser open (there is no
queue, the same limit as imports).

**The sub-goal gets most of its work from the same table:** base and latest paragraphs line up by
`(regulation, label)`, and a different `content_hash` marks a modified paragraph, a missing label a
removed or added one. The model then only judges which requirements each change touches.

## Input pictures (exploded views, drawings)

**Read the input picture with the vision model and search with text. No image-embedding index.**

Image embeddings (CLIP, SigLIP and similar) put pictures that look alike close together. The
input is a line drawing of a product; the regulation figures are approval marks, measurement grids,
angle diagrams and test set-ups. A rear-lamp drawing and the regulation that governs rear lamps do
not look alike, so visual nearest neighbours would mostly match drawing style (black lines on
white), not subject. That is an inference from looking at the dev drawing and a sample of figures,
not a measurement.

What works instead: the agent's model is multimodal. It reads the drawing and writes down what is in
it (housing, lens, LED array, reflector, which lamp functions), and that text goes into the scope
summaries and `search_paragraphs` like the written specification does. The pictures in the bucket
are for showing the user the figure a paragraph refers to, not for matching.

If the team wants evidence before dropping the idea: embed the 2,443 distinct regulation images with
a small CLIP model on CPU and check whether the dev drawing's nearest images belong to the
regulations the dev case expects. Minutes of work, and a yes or no answer.

## Extraction

Built in `agent/agent_service/domain/paragraphs.py`, run by the import (`regulations.py`) once its
files are stored, for every version of the library the current extractor (`EXTRACTOR`) has not split
yet. So importing the same index again splits a library imported before this existed, and changing
the splitter (and its `EXTRACTOR` value) re-splits the library on the next import. A version gets its
paragraphs replaced in one transaction (`replace_regulation_paragraphs`), and a different file under
the same version leaves it with none until the next import splits it (`record_regulation_version`).

Replaced paragraphs are not deleted: they are marked `superseded_at` (SYS-34, IF-3; Clemente and
Ramón on #3, 2026-10-24; migration `20261024270000_superseded_paragraphs.sql`). The reason is the
requirements: each cites a paragraph row, and deleting the row lost the text the requirement was
written from. A requirement on a superseded row is moved to the new row with the same label and
`content_hash`; one whose paragraph changed keeps the superseded row, and the check, which reads
current paragraphs only, reports it as no longer in the library. Every reader of the library as it
is now filters `superseded_at is null`: `match_regulation_paragraphs`, the embedding keys,
`version_paragraphs`, the version diff and the web paragraph list. A new reader has to do the same,
or it finds every paragraph once per split.

Superseded rows that no requirement cites are deleted once they are an hour old, by the next
import (`record_regulation_version`) or split (Ramón, 2026-10-24; migration
`20261024280000_purge_superseded_paragraphs.sql`). Each full re-split supersedes about 48,000 rows,
so without the purge they would add up against the free plan's 500 MB. The hour covers a run that
read the paragraphs just before a re-split and stores requirements with those ids a few minutes
later. A requirement whose paragraph was superseded with no match gets `paragraph_superseded_at`,
cleared again if a later split brings its text back, and the check reports it with that date.

What this does not do: re-run the check on its own. A flagged requirement is reported the next
time a run's check reads it.

How it works: pypdfium2 (already a dependency) gives the text of each page and the font size and
weight of each line. The PDFs were rendered from HTML by headless Chrome, so headings are bigger
than body text (17.3 against 14 pt) and part headings are bold. A paragraph starts at a line that
begins with a number that can follow the previous one: its parent is on the current path and the
jump from its sibling is at most 5. That rule is what keeps wrapped references ("paragraph\n8.",
"UN Regulation No.\n149.") from starting paragraphs; without it one of them swallowed 50 pages of
R48. Numbering restarts at every annex, appendix and part, which the label carries. The page is the
PDF page index, and the footer `version X | page n of N` is checked against it on every page.

Measured on 2026-10-24 on the challenge's 92 PDFs and the sub-goal's two (not committed; the tests
use a made-up PDF in `agent/tests/fixtures/regulation/`):

- 17 s for all 5,532 pages on one CPU core; 38 s for a whole import into a local stack, in one
  slice. 48,487 rows, 47,750 of them numbered paragraphs; 68 MB in the table with its indexes,
  per organisation.
- Every citation in the package is found with its page inside the paragraph's range: 119 of 121
  distinct citations of the dev case and 117 of 117 of the sub-goal. The two misses cite a table
  ("5.1.4.4.1. Table 3"): the paragraph is found, but its label has no table name.
- 6 versions report repeated labels: forms printed more than once (R164 Annex 3, R107 Annex 8),
  R101's Annex 7, whose first appendix heading is missing from the text layer, and a footnote
  marker before a heading in R40 1.1.0. The rows are kept; the label is just not unique there.

What it does not do: split tables out of their paragraph (a table's text stays in the paragraph it
follows), keep pictures, read text inside figures, or read scanned PDFs (refused with a message).
Docling was not needed for the citations above; it may still help table text.

## How we know it works

The dev case and `tools/score_local.py` are the test. For each expected (regulation, version, page),
does `search_paragraphs` with the dev specification return a paragraph on that page in the top k?
Compare full-text only, vectors only and both, and record recall at k. That number decides whether
the per-paragraph context line is worth its cost.

## What this does not do

- **No legal version model** (series of amendments, supplements, corrigenda, entry into force,
  which Contracting Party applies what). The challenge fixes one version per role and scores
  regulation and page, not applicability.
- **No cross-reference graph** between regulations. Useful (installation regulations point to
  device regulations), deferred until the basics score.
- **No OCR of body text**, because it is not needed. Text inside figures stays unread unless a
  measured miss shows it matters.
- **No separate vector database and no Supabase Vector Buckets**, at this size.
- **No languages other than English.**

## Build order

1. Bucket, tables and extraction to paragraphs with pages; full-text search only. Gives a baseline.
   Done.
2. Scope summaries per version. Built (#18).
3. Embeddings and the hybrid function; measure recall against step 1. Built (#18); recall not
   measured yet.
4. Context line per paragraph, only if step 3 leaves misses that headings would explain.
5. Pictures last: they are needed for display, not for matching.

## Decisions taken (2026-10-24)

- GTR 9 goes in the same tables, with `kind = 'GTR'`.
- Signed-in users can read the PDFs and pictures in the web app: the bucket gets a read policy for
  authenticated users; writes stay with the service key.
- Embeddings: OpenAI directly, OpenRouter as fallback (reasons above).
- The project is on the Supabase free plan: hence `halfvec(1024)` and the size checks above.
- Input pictures are read by the vision model into text; no image-embedding index.
