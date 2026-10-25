# Retrieval and extraction: what we learned, and what follows from it

A living record of the general findings behind how the agent finds regulations, reads them and
writes requirements. Written 2026-10-25 from a review of the current methods (sources at the end)
against our pipeline and our dev scores. Clemente asked on 2026-10-25 for these findings to be
recorded, and said "apply all" to the proposals. Nothing here names a regulation, a paragraph or a
page, and no figure here is used to tune anything (SYS-42).

All gains below are computed with F2 = 5PR / (4P + R) and 190 expected requirements. None of
them is measured unless it says so.

## 1. Where the score is lost

- **The leaderboard ranks requirement-level F2.** A model judge matches one submitted requirement
  to one expected one, by meaning. A requirement that merges two obligations matches at most one.
- **An extra requirement pays only if its chance of matching is above F2 / 5.** That is about 0.11
  at F2 0.54. It is the test for every "include it or not" rule, both for a single requirement and
  for a whole regulation (which brings dozens of requirements that all match with p ≈ 0 if it does
  not apply).
- **Regulation scoping is close to solved on dev.** After the product profile, the scope screen
  and the per-component search (#33, #53), the run of 2026-10-25 00:13 CEST had 6 requirements
  outside the key's regulations. Removing them all would be worth about +0.01.
- **The score is decided inside the right regulations.** The 4 regulations of the dev key hold
  about 1,200 paragraphs with a "shall" or "must"; the experts used about 8% of them. Deciding
  which obligations apply to the part is the hard step. Finding obligations is easy: a published
  classifier separates requirement text from other text at F1 0.96 (Gräßler et al. 2023). No
  published method solves applicability; that is our disposition step.
- **Precision and recall move against each other through the disposition.** Run of 01:40 CEST:
  634 requirements, estimate P 0.22, R 0.72, F2 0.49. After the precision changes (00:13 run):
  301 requirements, P 0.38, R 0.61, F2 0.54. At 00:13 recall is the bigger lever: winning back
  half of the 52 matches that change lost is worth about 0.64; cutting 80 of the 157 surplus
  requirements while losing 5 matches is worth only about 0.56.

## 2. What we already have, and what that rules out

- **Hybrid search is built** (`match_regulation_paragraphs`, #18): full text and
  `text-embedding-3-small` at 1,024 dimensions, fused by reciprocal rank (k = 60). That is the
  standard hybrid design. More of the same on the search side is not where the points are.
- **`regulation_paragraphs.context` exists and is empty.** It is part of the embedding input and of
  the full-text index (weight B), so filling it would improve both halves of the search at once.
- **Per-regulation ranking for one function or component** is built (`rank_regulations`, b61efeb,
  #53). The pipeline does not call it yet.

## 3. How we find the missing requirements

We cannot look at which expected requirements we miss and target them (SYS-42). Each cause of a
miss has a general mechanism instead:

| Cause (00:13 run, counted, not inspected one by one) | Mechanism |
|---|---|
| Test conditions that set a value were set aside (~26) | 0987754: they are obligations again |
| List items under a lead-in without "shall" were not split (~26) | 0987754: they are clauses |
| A single disposition answer drops some obligations by chance | `DISPOSITION_SAMPLES=2` with `DISPOSITION_VOTE=union` (de37a98) |
| Obligations in tables or headings with a value, no "shall" | Tables as rows at import (#52) |
| Values in another paragraph ("as specified in paragraph ...") | Referenced paragraphs attached to the translator (de37a98) |
| A "shall" paragraph or clause nobody answered for | The check lists it, and `write_for_paragraphs` writes it again |

How to tell which mechanism pays: dev runs as is, with 2 samples and union, and with 2 samples and
majority, each uploaded, and the platform's number decides (#54). The agreement counts in the trace
(units kept by every sample against those kept by only some) show how much of the output is
chance, without the answer key. Two samples double the first stage: watch the 770 s limit.

## 4. Findings from the literature, and what we did with each

- **Self-consistency** (Wang et al. 2022; Taubenfeld et al. 2025): sampling a model several times
  and voting removes its random errors. A confidence-weighted vote needs about 40% fewer samples
  than a plain one. RAFT (Xue et al. 2026), a regulation-to-requirement pipeline, votes 2 of 3
  where precision matters and takes the union where recall matters. **Built** as an option:
  `DISPOSITION_SAMPLES`, `DISPOSITION_VOTE` (de37a98). Off by default.
- **Tables are the hard part of PDF parsing**, as Certivity's partners said. In PDF-Bench (Dec
  2025, 17 parsers, 353 documents) the table score (TEDS) was pdfplumber 93.4%, pymupdf4llm 84.8%,
  Docling 84.5%. On PDFs with a real text layer, as ours have, a small pure-Python library beats
  the heavy ones, and Docling and Marker need model weights that do not fit a Vercel function.
  Model-based parsers scored 80 to 92% overall at $0.03 to $0.05 a page. **Proposed** for #52:
  pdfplumber on table pages (`paragraphs.py` already tells table text by its size), the model
  only where it finds nothing (comment on #52).
- **Cross-references.** Regulations state values and procedures by reference to other paragraphs.
  The useful part of graph-based retrieval for us is those explicit edges, not GraphRAG's entity
  graphs and community summaries, which answer global questions over a corpus. **Built**: up to 8
  referenced paragraphs attached per translator call (de37a98).
- **Contextual retrieval** (Anthropic 2024): 50 to 100 tokens of model-written context put before
  each chunk cut top-20 retrieval failures by 35% (embeddings), 49% (with BM25) and 67% (with a
  reranker), at about $1 per million document tokens with prompt caching. **Not now** (#55, after the
  freeze): our `context` column is ready for it, but search is no longer the bottleneck.
- **Rerankers** (Cohere Rerank 4, Voyage rerank-2.5, open cross-encoders). In LegalBench-RAG
  (Pipitone and Alami 2024) the general-purpose Cohere reranker lowered recall on legal text at
  every k (recall@64 61.1% against 62.2% without it). **Not adopted**: mixed evidence on legal
  text, a new provider key, and our screen and translators already have the model read the
  candidates.
- **Query rewriting (HyDE**, Gao et al. 2022): embed a made-up passage in the target's language
  instead of the query. Profile v2 already states functions in the generic terms regulations use,
  so the gain is smaller here. **Only if** the per-component ranking looks poor.
- **Another embedding model** (`text-embedding-3-large` or `voyage-3-large` at 1,024 dimensions)
  fits the same column with no migration, and re-embedding costs under a dollar. **Not now**: gain
  unknown, and choosing a model by recall on the dev paragraphs would be tuning to the dev case.
- **Not considered further**: ColBERT and late interaction (pgvector stores one vector per row),
  fine-tuning a classifier (the only labels we have are the dev key), LlamaParse and other
  external parsers (challenge data would leave our systems).

## 5. What this does not settle

- None of the gains in sections 1 and 3 is measured. The count model behind the estimates has one
  calibration point per platform upload (`requirement-level-score.md`, project files).
- The literature figures come from other corpora (contracts, finance, generic RAG sets). They
  argue for a direction, not for a number on our case.
- Applicability inside a regulation remains a judgement by a model against the product profile.
  Nothing here replaces that judgement, it only makes it less random and better informed.

## Sources

- Anthropic, Introducing Contextual Retrieval (2024): https://www.anthropic.com/news/contextual-retrieval
- Pipitone and Alami, LegalBench-RAG (2024): https://arxiv.org/abs/2408.10343
- PDF-Bench (2025): https://github.com/applied-artificial-intelligence/pdf-parser-benchmark
- Xue, Chen, Zhang, RAFT (2026): https://arxiv.org/abs/2601.09762
- Gräßler, Özcan, Preuß, AI-based extraction of requirements from regulations for automotive
  engineering (DfX 2023): https://www.designsociety.org/publication/46858/
- Taubenfeld et al., Confidence Improves Self-Consistency in LLMs (2025): https://arxiv.org/abs/2502.06233
- Wang et al., Self-Consistency Improves Chain of Thought Reasoning (2022): https://arxiv.org/abs/2203.11171
- Gao et al., Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE, 2022): https://arxiv.org/abs/2212.10496
