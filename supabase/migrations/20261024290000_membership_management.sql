-- Managing who belongs to which organisation without creating accounts (SYS-41, #30).
--
-- An account is one person; a membership is that person's place and role in one organisation,
-- and a person may have several. Until now the only way in was the add-person form, which goes
-- through the agent to create an auth user and always asks for a password, even for someone who
-- already has an account (the password is then ignored). These functions give an existing
-- account a place directly, take it away, and create an organisation with an existing account as
-- its first admin. They only write `memberships` and `organizations`, through the same checks as
-- set_member (private.can_manage, the last-admin rule, an audit row), so RLS does not change:
-- reading still goes through private.can_read on memberships.

-- Accounts an admin may pick from when adding people to `org`. A platform admin searches every
-- account. An organisation admin searches only people of organisations they already manage: they
-- see those emails on the People page anyway, and a search over every account would hand any
-- client's admin the list of every other client's people. They can still add anyone by typing the
-- exact email (add_member_by_email), as they could before through the add-person form.
create function public.find_people(org uuid, search text)
returns table (user_id uuid, email text, role text, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pattern text;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its people' using errcode = '42501';
  end if;
  if length(trim(coalesce(search, ''))) < 2 then
    return;
  end if;
  -- % and _ typed by the person are literal characters, not wildcards.
  pattern := '%' || replace(replace(replace(lower(trim(search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select u.id, u.email::text, here.role, here.status
    from auth.users u
    left join public.memberships here on here.user_id = u.id and here.organization_id = org
    where lower(u.email) like pattern
      and (private.is_platform_admin() or exists (
        select 1 from public.memberships m
        where m.user_id = u.id and private.can_manage(m.organization_id)
      ))
    order by u.email
    limit 20;
end;
$$;

-- Gives an existing account a role in `org`, active. Returns the account's id, or null when no
-- account has that email; the web then asks for an initial password and creates one through the
-- agent. The null tells an admin whether an email has an account somewhere, which the add-person
-- form already told them ("already had an account"); it does not tell them where.
create function public.add_member_by_email(org uuid, member_email text, member_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its people' using errcode = '42501';
  end if;
  select id into member from auth.users where lower(email) = lower(trim(member_email));
  if member is null then
    return null;
  end if;
  -- set_member checks the role, keeps the last-admin rule and writes the audit row.
  perform public.set_member(org, member, member_role, 'active');
  return member;
end;
$$;

-- Takes a person out of `org`. The account stays, with its other memberships, and so do the runs
-- and audit rows that name it. Suspending (set_member) is still there for someone who should keep
-- appearing on the People page; removing is for someone who should not be listed at all. The
-- email goes into the audit row because the audit page names people from the current members,
-- and a removed person would otherwise show as a bare id.
create function public.remove_member(org uuid, member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed public.memberships;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its people' using errcode = '42501';
  end if;
  select * into removed from public.memberships
  where organization_id = org and user_id = member
  for update;
  if removed.user_id is null then
    raise exception 'that person is not in this organisation' using errcode = 'P0002';
  end if;
  -- The same rule as set_member: nobody could manage the organisation again.
  if removed.role = 'admin' and removed.status = 'active' and not exists (
    select 1 from public.memberships
    where organization_id = org and role = 'admin' and status = 'active' and user_id <> member
  ) then
    raise exception 'this would leave the organisation without an admin' using errcode = '23514';
  end if;
  delete from public.memberships where organization_id = org and user_id = member;
  perform private.audit(org, 'member.removed', jsonb_build_object(
    'user_id', member, 'role', removed.role,
    'email', (select email::text from auth.users where id = member)));
end;
$$;

-- Creates an organisation and, when an email is given, makes that existing account its first
-- admin, in one transaction: if the email has no account nothing is created, so a typo does not
-- leave an organisation nobody manages. An empty email creates it with no member, as
-- create_organization does; a platform admin manages it anyway and adds people later.
create function public.create_organization_with_admin(org_name text, admin_email text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  admin uuid;
begin
  if not private.is_platform_admin() then
    raise exception 'only a platform admin creates organisations' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(admin_email, '')), '') is not null then
    select id into admin from auth.users where lower(email) = lower(trim(admin_email));
    if admin is null then
      raise exception 'no account has the email %; create the organisation without an admin and add them from People', trim(admin_email)
        using errcode = 'P0002';
    end if;
  end if;
  insert into public.organizations (name, created_by) values (org_name, (select auth.uid()))
  returning id into org;
  perform private.audit(org, 'organization.created',
    jsonb_build_object('name', org_name, 'admin', lower(trim(admin_email))));
  if admin is not null then
    insert into public.memberships (organization_id, user_id, role) values (org, admin, 'admin');
    perform private.audit(org, 'member.set',
      jsonb_build_object('user_id', admin, 'role', 'admin', 'status', 'active'));
  end if;
  return org;
end;
$$;

revoke all on function public.find_people(uuid, text), public.add_member_by_email(uuid, text, text),
  public.remove_member(uuid, uuid), public.create_organization_with_admin(text, text) from public, anon;
grant execute on function public.find_people(uuid, text), public.add_member_by_email(uuid, text, text),
  public.remove_member(uuid, uuid), public.create_organization_with_admin(text, text) to authenticated;
