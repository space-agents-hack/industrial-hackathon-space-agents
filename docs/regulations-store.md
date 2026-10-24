# Regulations store: proposal

Status: the import is built (bucket, catalogue tables, import from the app; see "Importing from
the app" below). Text extraction, search and embeddings are still a proposal. How the UN Regulation
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
        UN_R10_7.2.0.md       extracted text, with <!-- page n --> markers (not built yet)
        UN_R10_7.2.0.json     extraction output with page and position of each block (not built yet)
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

Logical schema, not yet a migration. Column names are proposals.

```
regulations            one row per regulation (56)
  id, code 'UN R10', slug 'UN_R10', kind 'UN R' | 'GTR', title, source_url

regulation_versions    one row per PDF (92)
  id, regulation_id, role 'base' | 'latest', version_label '7.3.0', status, sha256,
  size_bytes, page_count, pdf_path, md_path, json_path,
  scope_summary, keywords text[], summary_model,          -- AI, see below
  extracted_at, pipeline_version
  unique (regulation_id, version_label)

paragraphs             one row per numbered paragraph, table or definition (~50,000)
  id, version_id, parent_id,
  label 'Annex 3 Part 2 1.2'                              -- what the submission cites
  annex, part, number, heading, kind 'paragraph' | 'table' | 'definition' | 'caption',
  text, page_start, page_end, content_hash,
  context,                                                -- AI, see below
  fts tsvector generated from heading + context + text

paragraph_images       one row per kept picture
  id, version_id, paragraph_id null, page, path, caption, sha256

embeddings             one row per distinct text and model
  content_hash, model, embedding halfvec(1024)
  primary key (content_hash, model)
```

`embeddings` is keyed by `content_hash`, not by paragraph: most paragraphs are identical in base and
latest, so each distinct text is embedded once. It also lets a new model be added beside the old one.

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

Text first, per page, with PyMuPDF or `pdftotext`, then split on the numbering pattern, tracking the
current annex and part. That keeps page numbers exact and runs in minutes on CPU. Tables are the weak
point of plain text extraction. Docling handles tables better but is heavy on CPU, so try it on the
pages that contain tables, compared on two or three documents first.

Checks before loading: every page of every PDF produced text, paragraph numbers increase within each
annex, every paragraph has a page range inside the document.

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
   The bucket, the catalogue tables and the import are done; extraction is next.
2. Scope summaries per version.
3. Embeddings and the hybrid function; measure recall against step 1.
4. Context line per paragraph, only if step 3 leaves misses that headings would explain.
5. Pictures last: they are needed for display, not for matching.

## Decisions taken (2026-10-24)

- GTR 9 goes in the same tables, with `kind = 'GTR'`.
- Signed-in users can read the PDFs and pictures in the web app: the bucket gets a read policy for
  authenticated users; writes stay with the service key.
- Embeddings: OpenAI directly, OpenRouter as fallback (reasons above).
- The project is on the Supabase free plan: hence `halfvec(1024)` and the size checks above.
- Input pictures are read by the vision model into text; no image-embedding index.
