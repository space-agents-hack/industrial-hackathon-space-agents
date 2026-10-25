-- An admin deletes regulations from their organisation's library: one from its row on the
-- Regulations page, or all of them with "Clear library" (SYS-46, #56; Ramón, 2026-10-25).
--
-- What goes with a regulation, through the foreign keys that already exist: its versions, their
-- paragraphs (current and superseded), the paragraphs' search keys, the scope summaries (columns of
-- the version) and every project's choice of it (project_regulations).
--
-- What stays, on purpose:
--   requirements           keep their citation as text (regulation, version_label, page,
--                          paragraph) and their run; version_id and paragraph_id become null
--                          (the existing `on delete set null`). Deleting them would rewrite the
--                          record of a run a person may already have approved and exported.
--                          Re-importing the same regulation does not restore the link: the
--                          relink trigger looks for the old version_id, and the new version has
--                          another one. This is the one exception to SYS-34, and it takes an
--                          admin's explicit act.
--   regulation_embeddings  a cache keyed by the hash of the text that was embedded, not by
--                          paragraph. Re-importing the same PDFs then costs no embedding calls.
--                          The search reaches a vector only through a paragraph's key, so an
--                          orphaned vector is never returned.
--   regulation_imports     the history of what was imported, by whom, and what failed.
--
-- The PDFs in the `regulations` bucket do not go with the rows. The function returns their paths
-- and the web removes them as the signed-in admin (policy at the end), after the rows, as for case
-- files: a failure then leaves bytes nobody can reach, which scripts/purge-challenge-data.sh
-- empties, rather than a regulation listed whose file is gone.

create function public.delete_regulations(org uuid, regulation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids        uuid[];
  codes      text[];
  paths      text[];
  versions   integer;
  paragraphs integer;
  unlinked   integer;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation deletes regulations' using errcode = '42501';
  end if;
  if regulation_ids is null or cardinality(regulation_ids) = 0 then
    raise exception 'choose at least one regulation to delete' using errcode = '22023';
  end if;
  -- The web clears a library in batches. One call deletes every paragraph of the regulations it
  -- names, about 550 per version for the challenge's set, and a request from the browser is cut
  -- at the API's statement timeout (8 s on the hosted project). 25 regulations stays well inside it.
  if cardinality(regulation_ids) > 25 then
    raise exception 'delete at most 25 regulations at a time' using errcode = '22023';
  end if;
  -- An import in progress records versions by regulation code: it would put back a regulation
  -- being deleted, or fail half-way on a row that disappeared under it.
  if exists (select 1 from public.regulation_imports i
             where i.organization_id = org and i.status in ('queued', 'running', 'paused')) then
    raise exception 'an import is in progress; let it finish or cancel it before deleting regulations'
      using errcode = '55000';
  end if;

  -- Locked so that two admins deleting at once count and return each file once.
  select array_agg(r.id), array_agg(r.code order by r.code)
  into ids, codes
  from (select id, code from public.regulations
        where organization_id = org and id = any(regulation_ids)
        for update) r;
  if ids is null then
    raise exception 'none of these regulations is in this organisation''s library' using errcode = 'P0002';
  end if;

  select count(*)::integer,
         array_remove(array_agg(v.pdf_path) || array_agg(v.md_path), null)
  into versions, paths
  from public.regulation_versions v
  where v.regulation_id = any(ids);

  select count(*)::integer into paragraphs
  from public.regulation_paragraphs p
  join public.regulation_versions v on v.id = p.version_id
  where v.regulation_id = any(ids);

  select count(*)::integer into unlinked
  from public.requirements q
  join public.regulation_versions v on v.id = q.version_id
  where v.regulation_id = any(ids);

  delete from public.regulations where id = any(ids);

  perform private.audit(org, 'regulations.deleted', jsonb_build_object(
    'codes', to_jsonb(codes), 'versions', versions, 'paragraphs', paragraphs,
    'requirements_unlinked', unlinked));
  return jsonb_build_object(
    'regulations', cardinality(ids),
    'versions', versions,
    'paragraphs', paragraphs,
    'requirements_unlinked', unlinked,
    'paths', to_jsonb(coalesce(paths, array[]::text[])));
end;
$$;

-- For the confirmation: how many requirements cite each regulation, so the dialog can say how many
-- lose their link before anyone presses Delete. As the caller, so RLS decides what is counted.
create function public.regulation_citation_counts(org uuid)
returns table (regulation_id uuid, requirements integer)
language sql
stable
set search_path = ''
as $$
  select v.regulation_id, count(*)::integer
  from public.requirements q
  join public.regulation_versions v on v.id = q.version_id
  where q.organization_id = org and v.organization_id = org
  group by v.regulation_id;
$$;

revoke all on function public.delete_regulations(uuid, uuid[]),
  public.regulation_citation_counts(uuid) from public, anon, authenticated;
grant execute on function public.delete_regulations(uuid, uuid[]),
  public.regulation_citation_counts(uuid) to authenticated, service_role;

create policy "admins delete their organisation's regulation files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'regulations'
  and private.can_manage(private.path_organization(name))
);
