-- Paragraph keys in batches (#37). In production the indexer's first step,
-- refresh_regulation_embedding_keys over the whole library, was cancelled by the 8 s statement
-- timeout every request gets (authenticator's statement_timeout, which service_role inherits):
-- it hashes every current paragraph in one statement, 2.8 s for 48,760 paragraphs on a laptop and
-- longer on the hosted database. No key, no vector, so the library could never be indexed.
--
-- This adds keys only to current paragraphs that have none, at most p_limit per call; the agent
-- calls it until it returns fewer than it asked for. A paragraph whose text changes is a new row
-- (a re-extraction supersedes the old one, migration 20261024270000), so "has no key" covers new
-- text. What it does not cover: a key made stale by a change of the regulation's title or of the
-- input definition. The full refresh above still does that, on a library small enough or from SQL.

create function public.add_regulation_embedding_keys(p_organization_id uuid, p_limit integer default 2000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  added integer;
begin
  insert into public.regulation_paragraph_keys (paragraph_id, organization_id, input_sha256)
  select p.id, p.organization_id,
         public.regulation_embedding_key(r.code, r.title, p.heading, p.context, p.text)
  from public.regulation_paragraphs p
  join public.regulation_versions v on v.id = p.version_id
  join public.regulations r on r.id = v.regulation_id
  where p.organization_id = p_organization_id
    and p.superseded_at is null
    and not exists (select 1 from public.regulation_paragraph_keys k where k.paragraph_id = p.id)
  limit greatest(p_limit, 0)
  on conflict (paragraph_id) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

revoke all on function public.add_regulation_embedding_keys(uuid, integer) from public, anon, authenticated;
grant execute on function public.add_regulation_embedding_keys(uuid, integer) to service_role;
