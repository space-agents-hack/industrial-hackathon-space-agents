-- A re-extraction keeps the paragraphs it replaces, marked superseded, and moves requirements to
-- the new rows (SYS-34, IF-3; Clemente on #3, 2026-10-24: "do not remove the previous one, and
-- change references"; Ramón agreed the same day).
--
-- Until now replace_regulation_paragraphs() deleted a version's rows and inserted new ones, and a
-- requirement whose paragraph text changed lost its link (20261024250000_requirements.sql). The
-- requirement then said what it cited, but nobody could read the text it had been written from.
-- Now that text stays: a requirement keeps pointing at the superseded row until a current row
-- with the same label and text exists, and the trigger below moves it there.
--
-- Everything that reads the library as it is now (search, the writer's version_paragraphs, the
-- version diff, the web paragraph list) reads `superseded_at is null` only. A superseded row is
-- for the requirements that cite it, and for nothing else.
--
-- What this does NOT do: purge superseded rows. Each full re-split of the challenge library adds
-- about 48,000 rows; deleting the ones no requirement cites is a separate decision (#3).

alter table public.regulation_paragraphs add column superseded_at timestamptz;

-- Positions are unique among the current rows only: the superseded set of a version has the same
-- positions as the current one, and possibly several superseded sets.
alter table public.regulation_paragraphs
  drop constraint regulation_paragraphs_version_id_position_key;
create unique index regulation_paragraphs_current_position_key
on public.regulation_paragraphs (version_id, position) where superseded_at is null;

-- Partial, so the indexes every search uses do not grow with each re-extraction. The planner uses
-- them only when the query says `superseded_at is null`, which every reader below does.
drop index public.regulation_paragraphs_fts_idx;
create index regulation_paragraphs_fts_idx
on public.regulation_paragraphs using gin (fts) where superseded_at is null;
drop index public.regulation_paragraphs_label_idx;
create index regulation_paragraphs_label_idx
on public.regulation_paragraphs (version_id, label) where superseded_at is null;

-- ------------------------------------------------------------------------------------------
-- Superseding instead of deleting
-- ------------------------------------------------------------------------------------------

-- Marks a version's current paragraphs superseded and drops their embedding keys. The keys went
-- with the row before (on delete cascade); without this, prune_regulation_embeddings() would keep
-- every vector of every superseded text, and the vector search would find them.
create function private.supersede_regulation_paragraphs(p_version_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  with gone as (
    update public.regulation_paragraphs
    set superseded_at = now()
    where version_id = p_version_id and superseded_at is null
    returning id
  )
  delete from public.regulation_paragraph_keys k
  using gone
  where k.paragraph_id = gone.id;
$$;

revoke all on function private.supersede_regulation_paragraphs(uuid)
  from public, anon, authenticated;

-- As in 20261024200000, except that the previous paragraphs are superseded, not deleted.
create or replace function public.replace_regulation_paragraphs(
  p_version_id     uuid,
  p_sha256         text,
  p_extracted_with text,
  p_page_count     integer,
  p_paragraphs     jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  written integer;
begin
  select organization_id into org
  from public.regulation_versions
  where id = p_version_id and sha256 = p_sha256
  for update;
  if org is null then
    return null;
  end if;

  perform private.supersede_regulation_paragraphs(p_version_id);
  insert into public.regulation_paragraphs (version_id, organization_id, position, label, annex,
    appendix, part, number, heading, kind, text, page_start, page_end, content_hash)
  select p_version_id, org, p.position, p.label, p.annex, p.appendix, p.part, p.number,
    coalesce(p.heading, ''), p.kind, p.text, p.page_start, p.page_end, p.content_hash
  from jsonb_to_recordset(p_paragraphs) as p(position integer, label text, annex text,
    appendix text, part text, number text, heading text, kind text, text text, page_start integer,
    page_end integer, content_hash text);
  get diagnostics written = row_count;

  update public.regulation_versions
  set page_count = p_page_count,
      extracted_at = now(),
      extracted_with = p_extracted_with,
      extraction_error = null,
      paragraph_count = written
  where id = p_version_id;
  return written;
end;
$$;

-- As in 20261024200000: the library shows the error and no current paragraphs. The old ones are
-- superseded, not deleted, so the requirements written against them keep their text.
create or replace function public.record_regulation_extraction_failure(
  p_version_id     uuid,
  p_sha256         text,
  p_extracted_with text,
  p_error          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.regulation_versions
  set extracted_at = now(),
      extracted_with = p_extracted_with,
      extraction_error = left(p_error, 1000),
      paragraph_count = null
  where id = p_version_id and sha256 = p_sha256;
  if found then
    perform private.supersede_regulation_paragraphs(p_version_id);
  end if;
end;
$$;

-- As in 20261024200000: a different file under the same version supersedes its paragraphs, which
-- cite pages of a PDF that is no longer in the bucket. A requirement on one of them keeps the text
-- it was written from; the page it cites can no longer be opened.
create or replace function public.record_regulation_version(
  p_organization_id uuid,
  p_import_id      uuid,
  p_code           text,
  p_slug           text,
  p_kind           text,
  p_title          text,
  p_source_url     text,
  p_version_label  text,
  p_role           text,
  p_status         text,
  p_version_title  text,
  p_file_name      text,
  p_sha256         text,
  p_size_bytes     bigint,
  p_pdf_path       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  reg uuid;
  ver uuid;
  previous_sha256 text;
begin
  insert into public.regulations (organization_id, code, slug, kind, title, source_url)
  values (p_organization_id, p_code, p_slug, p_kind, p_title, p_source_url)
  on conflict on constraint regulations_organization_id_code_key do update
    set title = coalesce(excluded.title, public.regulations.title),
        source_url = coalesce(excluded.source_url, public.regulations.source_url)
  returning id into reg;

  if p_role is not null then
    update public.regulation_versions
    set role = null
    where regulation_id = reg and role = p_role and version_label <> p_version_label;
  end if;

  select sha256 into previous_sha256
  from public.regulation_versions
  where regulation_id = reg and version_label = p_version_label;

  insert into public.regulation_versions as v (regulation_id, organization_id, version_label, role,
    status, title, file_name, sha256, size_bytes, pdf_path, last_import_id)
  values (reg, p_organization_id, p_version_label, p_role, p_status, p_version_title,
    p_file_name, p_sha256, p_size_bytes, p_pdf_path, p_import_id)
  on conflict on constraint regulation_versions_regulation_id_version_label_key do update
    set role = excluded.role,
        status = excluded.status,
        title = excluded.title,
        file_name = excluded.file_name,
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        pdf_path = excluded.pdf_path,
        last_import_id = excluded.last_import_id,
        -- A different file is a different text: whatever was extracted from the old one is stale.
        md_path = case when v.sha256 = excluded.sha256 then v.md_path end,
        page_count = case when v.sha256 = excluded.sha256 then v.page_count end,
        extracted_at = case when v.sha256 = excluded.sha256 then v.extracted_at end,
        extracted_with = case when v.sha256 = excluded.sha256 then v.extracted_with end,
        extraction_error = case when v.sha256 = excluded.sha256 then v.extraction_error end,
        paragraph_count = case when v.sha256 = excluded.sha256 then v.paragraph_count end
  returning id into ver;

  if previous_sha256 is not null and previous_sha256 <> p_sha256 then
    perform private.supersede_regulation_paragraphs(ver);
  end if;
  return ver;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- Search reads current rows only (20261024210000_regulation_search.sql)
-- ------------------------------------------------------------------------------------------

-- As in 20261024210000, plus `superseded_at is null`. Superseded rows have no key any more
-- (private.supersede_regulation_paragraphs), and this keeps them from getting one back.
create or replace function public.refresh_regulation_embedding_keys(p_organization_id uuid)
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
    and p.superseded_at is null
  on conflict (paragraph_id) do update set input_sha256 = excluded.input_sha256
  where k.input_sha256 <> excluded.input_sha256;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- As in 20261024210000, plus `superseded_at is null`: a key left on a superseded row by an older
-- version of the code is not embedded.
create or replace function public.regulation_texts_to_embed(
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
    and p.superseded_at is null
    and not exists (
      select 1 from public.regulation_embeddings e
      where e.organization_id = p_organization_id and e.model = p_model
        and e.input_sha256 = k.input_sha256
    )
  order by k.input_sha256
  limit greatest(p_limit, 0)
$$;

-- As in 20261024210000, plus `superseded_at is null` in both halves. The final join reads rows by
-- the ids those halves returned, so it needs no filter of its own.
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
      and p.superseded_at is null
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
      and p.superseded_at is null
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

-- ------------------------------------------------------------------------------------------
-- Requirements follow the current rows (20261024250000_requirements.sql)
-- ------------------------------------------------------------------------------------------

-- As in 20261024250000, which filled only empty links (the old row had been deleted). Now the old
-- row stays, so a requirement on a superseded paragraph is moved too, when the new set has the
-- same label and text. One whose text changed keeps its superseded row, and the check, which
-- reads current paragraphs only, reports it as no longer in the library. Empty links are still
-- filled: requirements whose paragraph was deleted before this migration.
create or replace function private.relink_requirements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.requirements r
  set paragraph_id = n.id
  from inserted n
  where r.version_id = n.version_id
    and r.paragraph_hash = n.content_hash
    and r.paragraph is not distinct from n.label
    and (r.paragraph_id is null
         or exists (select 1 from public.regulation_paragraphs o
                    where o.id = r.paragraph_id and o.superseded_at is not null));
  return null;
end;
$$;

-- The relink above looks requirements up by version and text whether or not they have a link;
-- requirements_relink_idx covers only the empty ones.
create index requirements_version_hash_idx on public.requirements (version_id, paragraph_hash);
