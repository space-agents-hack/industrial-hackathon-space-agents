-- Search over the regulation library (docs/regulations-store.md, "Embeddings" and "Search") and a
-- scope summary per version. Builds on regulation_paragraphs (20261024190000), which the
-- extraction fills; this migration adds nothing to that table.
--
-- Who can do what:
--   any member, viewer      reads the scope summaries (new columns of regulation_versions, already
--                           readable through that table's policy).
--   the agent (secret key)  everything else: writes vectors and summaries, runs the search. The
--                           query has to be embedded with the provider's key, so the search runs
--                           in the agent, never from a browser.

create extension if not exists vector with schema extensions;

-- ------------------------------------------------------------------------------------------
-- Scope summaries. With 92 versions, every summary fits in one prompt, so the agent reads them all
-- to pick candidate regulations instead of searching for them.
-- ------------------------------------------------------------------------------------------

alter table public.regulation_versions
  add column scope_summary  text check (length(scope_summary) <= 4000),
  add column scope_keywords text[] check (cardinality(scope_keywords) <= 40),
  -- "provider:model" that wrote it, so a summary from a weaker model can be found and redone.
  add column summary_model  text check (length(summary_model) <= 200),
  -- The PDF the summary was written from. A different sha256 on the version means a new PDF was
  -- imported under the same label, and the summary is stale. A column of its own rather than a
  -- reset in record_regulation_version: that function is in a migration already on main.
  add column summary_sha256 text check (summary_sha256 ~ '^[0-9a-f]{64}$'),
  add column summarized_at  timestamptz;

-- ------------------------------------------------------------------------------------------
-- Embeddings
-- ------------------------------------------------------------------------------------------

-- What is embedded for one paragraph: the regulation, the section titles above the paragraph, the
-- AI context line when there is one, and the paragraph. "shall not exceed 30 cd" alone says
-- nothing about what it applies to; the headings do. Defined once, here, so the agent embeds
-- exactly what the search looks up: the agent reads the inputs from the database and never builds
-- them itself.
--
-- Changing this definition changes every key, so the next indexing embeds the whole library again
-- (about 3 million tokens, well under a dollar with text-embedding-3-small) and prunes the old
-- vectors. That is the intended way to try a different input.
--
-- 24,000 characters is about 6,000 tokens: under the 8,191-token limit per input of the OpenAI
-- embedding models with room for dense tables, which tokenise worse than prose.
create function public.regulation_embedding_input(
  code text, title text, heading text, context text, body text
)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select left(concat_ws(E'\n',
    nullif(left(concat_ws(' ', code, title), 300), ''),
    nullif(heading, ''),
    nullif(context, ''),
    body), 24000)
$$;

-- The key of a vector: sha256 of the input above. Not regulation_paragraphs.content_hash, which
-- hashes the paragraph text alone (the diff between versions needs exactly that), while the vector
-- depends on the headings and the regulation's title too. Two hashes with two names, on purpose.
create function public.regulation_embedding_key(
  code text, title text, heading text, context text, body text
)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select encode(sha256(convert_to(public.regulation_embedding_input(code, title, heading, context, body), 'UTF8')), 'hex')
$$;

-- One vector per distinct input, organisation and model. Most paragraphs are identical in base and
-- latest, so they share one row. Per organisation, not shared between them, so deleting an
-- organisation deletes its vectors with it (SYS-24).
--
-- halfvec(1024): text-embedding-3-small shortened to 1,024 dimensions (the API's `dimensions`
-- parameter) and stored at half precision. Measured on 2026-10-24 with synthetic rows: 34,776
-- vectors (the distinct texts of 49,680 paragraphs) take 101 MB with their key. Full 1,536 floats
-- would be three times that, most of the free plan's 500 MB database.
--
-- No ANN index: an exact scan of 50,000 rows filtered by version is fast enough, and HNSW combined
-- with a filter can return fewer rows than asked for. Add one only when a measurement says so.
create table public.regulation_embeddings (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- "provider:model@dimensions", e.g. "openai:text-embedding-3-small@1024". Vectors from two
  -- models, or two lengths of the same one, are not comparable: the search only ever compares a
  -- query with vectors of the same string.
  model            text not null check (length(model) between 1 and 200),
  input_sha256     text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  embedding        extensions.halfvec(1024) not null,
  created_at       timestamptz not null default now(),
  primary key (organization_id, model, input_sha256)
);

-- Which vector belongs to which paragraph. Stored, not computed in the search: the first version
-- hashed every paragraph in scope on each query, and the planner turned that into 7.9 s for a
-- search over 50,000 paragraphs, or into a nested loop that did not finish in ten minutes.
--
-- The cost is that a key can be out of date: refresh_regulation_embedding_keys has to run after
-- every extraction, and the indexer does that first. Until it runs, a new paragraph has no key and
-- is found by full text only; a re-extracted one with the same id keeps its old vector. Neither
-- returns a wrong page: the page and text always come from regulation_paragraphs.
create table public.regulation_paragraph_keys (
  paragraph_id     uuid primary key references public.regulation_paragraphs (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  input_sha256     text not null check (input_sha256 ~ '^[0-9a-f]{64}$')
);

create index regulation_paragraph_keys_org_key_idx
on public.regulation_paragraph_keys (organization_id, input_sha256);

alter table public.regulation_embeddings enable row level security;
alter table public.regulation_paragraph_keys enable row level security;
revoke all on public.regulation_embeddings, public.regulation_paragraph_keys from anon, authenticated;
grant all on public.regulation_embeddings, public.regulation_paragraph_keys to service_role;

-- Brings every paragraph's key up to date with its text, headings and regulation title. Returns
-- how many keys were added or changed. About 2 s for 50,000 paragraphs on a laptop.
create function public.refresh_regulation_embedding_keys(p_organization_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  insert into public.regulation_paragraph_keys as k (paragraph_id, organization_id, input_sha256)
  select p.id, p.organization_id,
         public.regulation_embedding_key(r.code, r.title, p.heading, p.context, p.text)
  from public.regulation_paragraphs p
  join public.regulation_versions v on v.id = p.version_id
  join public.regulations r on r.id = v.regulation_id
  where p.organization_id = p_organization_id
  on conflict (paragraph_id) do update set input_sha256 = excluded.input_sha256
  where k.input_sha256 <> excluded.input_sha256;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- The inputs that have no vector yet for this model, one row per distinct input. The agent embeds
-- these and writes them back; when this returns nothing, the library is indexed.
create function public.regulation_texts_to_embed(
  p_organization_id uuid,
  p_model text,
  p_limit integer default 500
)
returns table (input_sha256 text, input text)
language sql
stable
set search_path = ''
as $$
  select distinct on (k.input_sha256)
         k.input_sha256,
         public.regulation_embedding_input(r.code, r.title, p.heading, p.context, p.text)
  from public.regulation_paragraph_keys k
  join public.regulation_paragraphs p on p.id = k.paragraph_id
  join public.regulation_versions v on v.id = p.version_id
  join public.regulations r on r.id = v.regulation_id
  where k.organization_id = p_organization_id
    and not exists (
      select 1 from public.regulation_embeddings e
      where e.organization_id = p_organization_id and e.model = p_model
        and e.input_sha256 = k.input_sha256
    )
  order by k.input_sha256
  limit greatest(p_limit, 0)
$$;

-- Vectors that no paragraph points to any more: the text was extracted again differently, the
-- input definition changed, or the regulation's title did. Returns how many were deleted.
create function public.prune_regulation_embeddings(p_organization_id uuid, p_model text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.regulation_embeddings e
  where e.organization_id = p_organization_id
    and e.model = p_model
    and not exists (
      select 1 from public.regulation_paragraph_keys k
      where k.organization_id = p_organization_id and k.input_sha256 = e.input_sha256
    );
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Fresh planner statistics for the search tables. The indexer calls it after it writes many rows.
-- Measured on 2026-10-24: with 50,000 paragraphs just written and no statistics yet, a search over
-- 10 versions did not finish in 30 s (one run took 6 minutes); after ANALYZE it took 0.1 s.
-- Autovacuum would analyse the tables within a minute or so, but the first searches after an import
-- are exactly the ones someone is watching. Security definer because only a table's owner may
-- analyse it, and the agent's role does not own them; it can do nothing else through this.
create function public.analyze_regulation_search()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  analyze public.regulation_paragraphs, public.regulation_paragraph_keys, public.regulation_embeddings;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- Hybrid search
-- ------------------------------------------------------------------------------------------

-- Full-text candidates and vector candidates, merged by reciprocal rank fusion: each list
-- contributes 1 / (60 + rank). Fusing ranks instead of scores is what lets two scales that have
-- nothing in common (ts_rank and cosine distance) be combined without tuning a weight; 60 is the
-- constant from the paper that introduced it (Cormack, Clarke and Buettcher, 2009) and the usual
-- default.
--
-- Full text matches ANY word of the query, ranked by how often the words occur (ts_rank). The query
-- is usually a passage of a specification, and requiring every word of it would match nothing.
-- ts_rank_cd, which also rewards words close together, took 1.3 s instead of 0.14 s over 50,000
-- paragraphs that all matched a broad query.
--
-- Either half can be switched off: p_query null or empty gives vectors only, p_query_embedding null
-- gives full text only. That is how the recall of each is measured against both
-- (docs/regulations-store.md, "How we know it works").
--
-- p_version_ids null searches the whole library of the organisation. Both filters apply to both
-- halves, so a version id from another organisation finds nothing.
create function public.match_regulation_paragraphs(
  p_organization_id  uuid,
  p_query            text,
  p_query_embedding  extensions.halfvec(1024),
  p_model            text,
  p_version_ids      uuid[] default null,
  p_k                integer default 20,
  p_candidates       integer default 100
)
returns table (
  paragraph_id    uuid,
  version_id      uuid,
  regulation_code text,
  version_label   text,
  role            text,
  label           text,
  heading         text,
  kind            text,
  text            text,
  page_start      integer,
  page_end        integer,
  score           double precision,
  text_rank       integer,
  vector_rank     integer,
  similarity      double precision
)
language plpgsql
stable
set search_path = ''
-- Planned with the actual organisation and versions on every call. As a SQL function the query was
-- planned once with placeholders, and that plan took minutes on 50,000 paragraphs where the same
-- query with the values in it took 1 s.
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  return query
  -- Materialised so the query is parsed once. Inlined, it was parsed again for every paragraph,
  -- 3.6 s of a 7.9 s search over 50,000 paragraphs.
  with query as materialized (
    -- plainto_tsquery joins the words with AND; its text form is rewritten to OR. Quoted lexemes
    -- cannot contain " & ", so the replace touches only the operators.
    select case when btrim(coalesce(p_query, '')) <> '' then
      nullif(replace(plainto_tsquery('english', p_query)::text, ' & ', ' | '), '')::tsquery
    end as tsq
  ),
  by_text as (
    select p.id,
           row_number() over (order by ts_rank(p.fts, q.tsq) desc, p.id)::integer as rank
    from public.regulation_paragraphs p, query q
    where q.tsq is not null
      and p.organization_id = p_organization_id
      and (p_version_ids is null or p.version_id = any (p_version_ids))
      and p.fts @@ q.tsq
    order by rank
    limit greatest(p_candidates, 0)
  ),
  by_vector as (
    select p.id,
           row_number() over (order by e.embedding operator(extensions.<=>) p_query_embedding, p.id)::integer as rank,
           1 - (e.embedding operator(extensions.<=>) p_query_embedding) as similarity
    from public.regulation_paragraphs p
    join public.regulation_paragraph_keys k on k.paragraph_id = p.id
    join public.regulation_embeddings e
      on e.organization_id = p_organization_id
     and e.model = p_model
     and e.input_sha256 = k.input_sha256
    where p_query_embedding is not null
      and p.organization_id = p_organization_id
      and (p_version_ids is null or p.version_id = any (p_version_ids))
    order by rank
    limit greatest(p_candidates, 0)
  ),
  fused as (
    select coalesce(t.id, v.id) as id, t.rank as text_rank, v.rank as vector_rank, v.similarity,
           coalesce(1.0 / (60 + t.rank), 0) + coalesce(1.0 / (60 + v.rank), 0) as score
    from by_text t
    full join by_vector v on v.id = t.id
  )
  select p.id, p.version_id, r.code, v.version_label, v.role, p.label, p.heading, p.kind, p.text,
         p.page_start, p.page_end, f.score::double precision, f.text_rank, f.vector_rank,
         f.similarity::double precision
  from fused f
  join public.regulation_paragraphs p on p.id = f.id
  join public.regulation_versions v on v.id = p.version_id
  join public.regulations r on r.id = v.regulation_id
  order by f.score desc, p.id
  limit greatest(p_k, 0);
end;
$$;

revoke all on function
  public.regulation_embedding_input(text, text, text, text, text),
  public.regulation_embedding_key(text, text, text, text, text),
  public.refresh_regulation_embedding_keys(uuid),
  public.regulation_texts_to_embed(uuid, text, integer),
  public.prune_regulation_embeddings(uuid, text),
  public.analyze_regulation_search(),
  public.match_regulation_paragraphs(uuid, text, extensions.halfvec, text, uuid[], integer, integer)
  from public, anon, authenticated;
grant execute on function
  public.regulation_embedding_input(text, text, text, text, text),
  public.regulation_embedding_key(text, text, text, text, text),
  public.refresh_regulation_embedding_keys(uuid),
  public.regulation_texts_to_embed(uuid, text, integer),
  public.prune_regulation_embeddings(uuid, text),
  public.analyze_regulation_search(),
  public.match_regulation_paragraphs(uuid, text, extensions.halfvec, text, uuid[], integer, integer)
  to service_role;
