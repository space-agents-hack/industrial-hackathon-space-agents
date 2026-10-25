-- Pruning vectors in batches (#57). prune_regulation_embeddings deletes, in one statement, every
-- vector of the organisation that no current paragraph points to. After the library was cleared
-- (#56 keeps the embedding cache) and re-split with figures (#52 supersedes every paragraph, and
-- a superseded paragraph loses its key), that is nearly all of them: about 29,655 vectors of 2 KB,
-- each with its TOAST chunks and an HNSW index entry, against the 8 s statement timeout.
--
-- This deletes at most p_limit per call; the agent calls it until it returns fewer than it asked
-- for. The two-argument version stays for the code already deployed (migrations run before it).

create function public.prune_regulation_embeddings(
  p_organization_id uuid,
  p_model text,
  p_limit integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  with orphans as materialized (
    select e.input_sha256
    from public.regulation_embeddings e
    where e.organization_id = p_organization_id
      and e.model = p_model
      and not exists (
        select 1 from public.regulation_paragraph_keys k
        where k.organization_id = p_organization_id and k.input_sha256 = e.input_sha256
      )
    limit greatest(p_limit, 0)
  )
  delete from public.regulation_embeddings e
  using orphans o
  where e.organization_id = p_organization_id
    and e.model = p_model
    and e.input_sha256 = o.input_sha256;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.prune_regulation_embeddings(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.prune_regulation_embeddings(uuid, text, integer) to service_role;
