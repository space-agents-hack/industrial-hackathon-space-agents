-- Finding paragraphs without a key, fast when there are none (#41). In production, once team-09's
-- 46,084 paragraphs all had keys, the last call of every slice (the one that confirms nothing is
-- missing) took 17.6 s against the 8 s statement timeout: the planner walked regulation_paragraphs
-- in primary-key order across both organisations, reading one heap page per row (94,181 buffer
-- reads), to find nothing. Indexing stopped at 65%.
--
-- The index holds what the lookup and regulation_index_status need (organisation, id, version) for
-- current rows only, so both can answer from the index without reading the paragraph rows, whose
-- text makes them large. The function looks for the missing ids first and joins the regulation
-- (for the key's title) only for the ones it found.

create index regulation_paragraphs_current_org_idx
on public.regulation_paragraphs (organization_id, id) include (version_id)
where superseded_at is null;

create or replace function public.add_regulation_embedding_keys(p_organization_id uuid, p_limit integer default 2000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  added integer;
begin
  with missing as materialized (
    select p.id
    from public.regulation_paragraphs p
    where p.organization_id = p_organization_id
      and p.superseded_at is null
      and not exists (select 1 from public.regulation_paragraph_keys k where k.paragraph_id = p.id)
    limit greatest(p_limit, 0)
  )
  insert into public.regulation_paragraph_keys (paragraph_id, organization_id, input_sha256)
  select p.id, p.organization_id,
         public.regulation_embedding_key(r.code, r.title, p.heading, p.context, p.text)
  from missing m
  join public.regulation_paragraphs p on p.id = m.id
  join public.regulation_versions v on v.id = p.version_id
  join public.regulations r on r.id = v.regulation_id
  on conflict (paragraph_id) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;
