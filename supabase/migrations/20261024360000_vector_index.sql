-- Searches that fit the 8 s statement timeout (#44). The first run on production after team-09's
-- library was indexed failed: match_regulation_paragraphs took 6.6 to 13.4 s alone and about 18 s
-- with the three searches a run fires at once (measured read-only on 2026-10-24, smallest compute
-- size). Two halves, two causes:
--
--   by meaning: no vector index. Every search joined the organisation's 46,084 current paragraphs
--   to their keys and vectors, computed 46,084 distances (one per paragraph, for 29,655 distinct
--   vectors), read each vector out of TOAST (about 150,000 buffers) and sorted them all to keep
--   100. The HNSW index read 17,000 buffers for the same answer locally. It is approximate: on
--   made-up clustered vectors 93 to 100 of the exact 100 nearest were among the 400 it returns
--   (on uniform random vectors, which have no neighbours to speak of, 57). The agent reads the
--   regulations it picks in full anyway (SYS-28).
--
--   by words: the OR query of a few common words ("test", "lamp") matched 42,171 current
--   paragraphs of both organisations, fetched every one and threw the other organisation's away.
--   The organisation in the text index (btree_gin) leaves only this organisation's.
--
-- What this does NOT do: make ranking 20,000 word matches cheap. ts_rank still reads each match.

create extension if not exists btree_gin with schema extensions;

-- Built while the migration holds a lock that blocks writes to the table (not reads): about a
-- minute for 30,000 vectors at the default maintenance_work_mem (an estimate; locally, 94,000
-- vectors took 7 min once the graph no longer fitted in memory). Indexing waits; searches go on.
create index regulation_embeddings_hnsw_idx
on public.regulation_embeddings using hnsw (embedding extensions.halfvec_cosine_ops);

create index regulation_paragraphs_current_org_fts_idx
on public.regulation_paragraphs using gin (organization_id, fts)
where superseded_at is null;

create or replace function public.match_regulation_paragraphs(
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
-- The planner does not count reading each vector out of TOAST, so it judges a scan of the whole
-- table and a sort cheaper than the index: locally it switched to that plan as soon as ef_search
-- was 200, at 170,000 buffers instead of 17,000. Every other read here has an index of its own.
set enable_seqscan = off
as $$
#variable_conflict use_column
declare
  -- Nearest distinct texts to look at per candidate: a text is shared by the versions that repeat
  -- a paragraph, and some of its paragraphs may be outside p_version_ids.
  texts_per_candidate constant integer := 4;
  -- At most this many paragraphs in p_version_ids: compare the query with each of them exactly
  -- instead. A project that uses a few regulations (SYS-32) would otherwise get few or no
  -- results from the nearest texts of the whole library. A tenth of a 46,000-paragraph library
  -- is about a tenth of the exact search's time.
  exact_limit constant integer := 5000;
  exact boolean := false;
begin
  if p_query_embedding is not null then
    -- Both organisations' vectors share the index, so a plain HNSW scan finds the nearest of
    -- either and drops the other's afterwards, returning fewer than asked. An iterative scan
    -- keeps going until it has enough; the results are put in order again below. Set here and
    -- not as `set` clauses of the function: pgvector's settings exist only once its library is
    -- loaded, which a search by words alone never does, and before that the database refuses
    -- them ("permission denied to set parameter"). For the rest of this transaction, which
    -- through the API is this one call.
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    perform set_config('hnsw.ef_search', '100', true);
  end if;

  if p_query_embedding is not null and p_version_ids is not null then
    select count(*) <= exact_limit into exact
    from (
      select 1
      from public.regulation_paragraphs p
      where p.organization_id = p_organization_id
        and p.superseded_at is null
        and p.version_id = any (p_version_ids)
      limit exact_limit + 1
    ) chosen;
  end if;

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
      and p.superseded_at is null
      and p.fts @@ q.tsq
    order by rank
    limit greatest(p_candidates, 0)
  ),
  nearest as materialized (
    (
      select e.input_sha256,
             e.embedding operator(extensions.<=>) p_query_embedding as distance
      from public.regulation_embeddings e
      where p_query_embedding is not null
        and not exact
        and e.organization_id = p_organization_id
        and e.model = p_model
      order by e.embedding operator(extensions.<=>) p_query_embedding
      limit greatest(p_candidates, 0) * texts_per_candidate
    )
    union all
    (
      select e.input_sha256,
             e.embedding operator(extensions.<=>) p_query_embedding as distance
      from (
        select distinct k.input_sha256
        from public.regulation_paragraphs p
        join public.regulation_paragraph_keys k on k.paragraph_id = p.id
        where exact
          and p.organization_id = p_organization_id
          and p.superseded_at is null
          and p.version_id = any (p_version_ids)
      ) chosen
      join public.regulation_embeddings e
        on e.organization_id = p_organization_id
       and e.model = p_model
       and e.input_sha256 = chosen.input_sha256
      order by e.embedding operator(extensions.<=>) p_query_embedding
      limit greatest(p_candidates, 0) * texts_per_candidate
    )
  ),
  by_vector as (
    select p.id,
           row_number() over (order by n.distance, p.id)::integer as rank,
           1 - n.distance as similarity
    from nearest n
    join public.regulation_paragraph_keys k
      on k.organization_id = p_organization_id
     and k.input_sha256 = n.input_sha256
    join public.regulation_paragraphs p on p.id = k.paragraph_id
    where p.superseded_at is null
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
