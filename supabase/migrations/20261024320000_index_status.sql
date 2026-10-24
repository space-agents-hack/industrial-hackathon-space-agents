-- The assistant's model as a process of its own, and what the Regulations page shows about the
-- search index (#37; SYS-28, SYS-33, SYS-39).
--
-- Why: in production the library had 48,487 paragraphs, no vector and no scope summary, and
-- nothing said so. Every search matched words only. The page now shows, per version, how many of
-- its paragraphs have a vector of each model; the summaries are columns members already read.

-- 'chat': the assistant (agent domain/assistant.py). Widening a check keeps every row that is
-- there valid, and the running agent never writes 'chat', so the order of release does not matter.
alter table public.organization_models drop constraint organization_models_process_check;
alter table public.organization_models add constraint organization_models_process_check
  check (process in ('check', 'transcription', 'summary', 'embedding', 'chat'));

-- Per version of the organisation's library: its current paragraphs, how many have a key (the
-- hash the indexer embeds; none until the indexer has run once since the extraction), and how many
-- have a vector, per embedding model ("openai:text-embedding-3-small@1024"). The vectors
-- themselves stay unreadable: 1,024 numbers say nothing to a person.
--
-- Security definer because regulation_embeddings and regulation_paragraph_keys are the agent's
-- alone; the check below is the same as for reading the library itself. Counts only, no text.
create function public.regulation_index_status(org uuid)
returns table (
  version_id       uuid,
  paragraphs       bigint,
  keyed            bigint,
  vectors          jsonb,
  last_embedded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_read(org) then
    raise exception 'not a member of this organisation' using errcode = '42501';
  end if;
  return query
  with current_paragraphs as (
    select p.id, p.version_id, k.input_sha256
    from public.regulation_paragraphs p
    left join public.regulation_paragraph_keys k on k.paragraph_id = p.id
    where p.organization_id = org and p.superseded_at is null
  ),
  per_model as (
    select c.version_id, e.model, count(*) as n, max(e.created_at) as last_at
    from current_paragraphs c
    join public.regulation_embeddings e
      on e.organization_id = org and e.input_sha256 = c.input_sha256
    group by c.version_id, e.model
  ),
  totals as (
    select c.version_id, count(*) as paragraphs, count(c.input_sha256) as keyed
    from current_paragraphs c
    group by c.version_id
  )
  select t.version_id,
         t.paragraphs,
         t.keyed,
         coalesce((select jsonb_object_agg(m.model, m.n) from per_model m
                   where m.version_id = t.version_id), '{}'::jsonb),
         (select max(m.last_at) from per_model m where m.version_id = t.version_id)
  from totals t;
end;
$$;

revoke all on function public.regulation_index_status(uuid) from public, anon;
grant execute on function public.regulation_index_status(uuid) to authenticated;
