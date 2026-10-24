-- An organisation's admins rename it from the app (#35; docs/se SYS-4, IF-4).
--
-- Why now: a submission's `team_id` is the organisation's name (3090885), and the platform scores
-- a file under that id, so the name has to become the team's platform id ("team-09"). Until this
-- migration nothing in the app could change it: `organizations` has no update grant and no
-- function wrote the name after creation. The only way was SQL in the dashboard.
--
-- Who may: the organisation's admins and platform admins (private.can_manage), as for its
-- settings and keys. The change is audited with the old and the new name, because a rename changes
-- what every later submission says it is.
--
-- What this does NOT do: change names already copied elsewhere. A pending access request keeps
-- the name it was made under (access_requests.organization_name), and a run that already finished
-- keeps the team_id in its output. Additive: running code never calls it.

create function public.rename_organization(org uuid, new_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_name text;
  wanted text := btrim(coalesce(new_name, ''));
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation renames it' using errcode = '42501';
  end if;
  if length(wanted) not between 1 and 200 then
    raise exception 'an organisation needs a name of 1 to 200 characters' using errcode = '22023';
  end if;
  select name into old_name from public.organizations where id = org for update;
  if old_name is null then
    raise exception 'no such organisation' using errcode = 'P0002';
  end if;
  if old_name = wanted then
    return;
  end if;
  update public.organizations set name = wanted where id = org;
  perform private.audit(org, 'organization.renamed',
    jsonb_build_object('from', old_name, 'to', wanted));
end;
$$;

revoke all on function public.rename_organization(uuid, text) from public, anon;
grant execute on function public.rename_organization(uuid, text) to authenticated;
