-- How a person who signed up gets into an organisation (Clemente, 2026-10-24): they ask to join an
-- existing one, and one of its admins approves; or they ask for a new one, and a platform admin
-- approves it, after which they are its admin.
--
-- Why a new organisation is approved too: an organisation without its own provider key runs on
-- the deployment's keys, and organization_settings.monthly_cost_cap_usd is null (no cap) by
-- default. Created at once, anyone who finds the URL could run models on the deployment's bill.
--
-- Accounts still grant nothing on their own: without an active membership every table is empty
-- to them (RLS). That is what makes self sign-up acceptable at all; it stays a hosted setting
-- (supabase/README.md).

create table public.access_requests (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  -- Copied at request time: admins cannot read auth.users, and a requester cannot read an
  -- organisation they are not in yet, so each side sees the other's name from here.
  email              text not null,
  kind               text not null check (kind in ('join', 'create')),
  -- The organisation to join; for 'create', the one made on approval.
  organization_id    uuid references public.organizations (id) on delete cascade,
  organization_name  text not null check (length(btrim(organization_name)) between 1 and 200),
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'declined', 'cancelled')),
  -- The role given on approval; 'create' always makes the requester admin.
  granted_role       text check (granted_role in ('admin', 'member', 'viewer')),
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid references auth.users (id) on delete set null,
  check (kind = 'create' or organization_id is not null)
);

-- One open request per person and organisation, and one open request for a new organisation per
-- person: asking twice is a double click, not a second request.
create unique index access_requests_one_open_join
  on public.access_requests (user_id, organization_id) where status = 'pending' and kind = 'join';
create unique index access_requests_one_open_create
  on public.access_requests (user_id) where status = 'pending' and kind = 'create';
create index access_requests_org_idx on public.access_requests (organization_id) where status = 'pending';

alter table public.access_requests enable row level security;
revoke all on public.access_requests from anon, authenticated;
grant select on public.access_requests to authenticated;
grant all on public.access_requests to service_role;

-- Writes only through the functions below, which check who may decide.
create policy "people read their own requests and the ones they decide"
on public.access_requests for select to authenticated
using (
  user_id = (select auth.uid())
  or (kind = 'join' and private.can_manage(organization_id))
  or (kind = 'create' and private.is_platform_admin())
);

-- The organisations a person can ask to join, by name. Any signed-in account sees every
-- organisation's name and nothing else (Clemente asked that the person selects one). The cost:
-- client names are visible to anyone who has an account.
create function public.joinable_organizations()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name from public.organizations o
  where (select auth.uid()) is not null
    and not exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.status = 'active'
    )
  order by o.name;
$$;

create function public.request_to_join(org uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  my_email text;
  org_name text;
  request uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select name into org_name from public.organizations where id = org;
  if org_name is null then
    raise exception 'no such organisation' using errcode = 'P0002';
  end if;
  -- A suspended member asking again would bypass the admin who suspended them.
  if exists (select 1 from public.memberships where organization_id = org and user_id = me) then
    raise exception 'you already have a membership in this organisation' using errcode = '23505';
  end if;
  select id into request from public.access_requests
  where user_id = me and organization_id = org and kind = 'join' and status = 'pending';
  if request is not null then
    return request;
  end if;
  select email into my_email from auth.users where id = me;
  insert into public.access_requests (user_id, email, kind, organization_id, organization_name)
  values (me, coalesce(my_email, ''), 'join', org, org_name)
  returning id into request;
  perform private.audit(org, 'access.requested', jsonb_build_object('request', request, 'email', my_email));
  return request;
end;
$$;

create function public.request_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  my_email text;
  request uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if length(btrim(coalesce(org_name, ''))) not between 1 and 200 then
    raise exception 'an organisation needs a name of 1 to 200 characters' using errcode = '22023';
  end if;
  select email into my_email from auth.users where id = me;
  insert into public.access_requests (user_id, email, kind, organization_name)
  values (me, coalesce(my_email, ''), 'create', btrim(org_name))
  on conflict (user_id) where status = 'pending' and kind = 'create'
  do update set organization_name = excluded.organization_name
  returning id into request;
  perform private.audit(null, 'organization.requested',
    jsonb_build_object('request', request, 'name', btrim(org_name), 'email', my_email));
  return request;
end;
$$;

create function public.cancel_access_request(request uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.access_requests set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid())
  where id = request and user_id = (select auth.uid()) and status = 'pending';
$$;

-- Approve or decline. A join is decided by an admin of that organisation (or a platform admin); a
-- new organisation by a platform admin only. Approving a join makes or reactivates nothing that
-- already exists: request_to_join refuses anyone with a membership, suspended included.
create function public.decide_access_request(request uuid, approve boolean, member_role text default 'member')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.access_requests;
  org uuid;
begin
  select * into r from public.access_requests where id = request for update;
  if r.id is null then
    raise exception 'no such request' using errcode = 'P0002';
  end if;
  if (r.kind = 'join' and not private.can_manage(r.organization_id))
     or (r.kind = 'create' and not private.is_platform_admin()) then
    raise exception 'you cannot decide this request' using errcode = '42501';
  end if;
  if r.status <> 'pending' then
    raise exception 'this request was already %', r.status using errcode = '55000';
  end if;
  if member_role not in ('admin', 'member', 'viewer') then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  if not approve then
    update public.access_requests set status = 'declined', decided_at = now(), decided_by = (select auth.uid())
    where id = request;
    perform private.audit(r.organization_id, 'access.declined', jsonb_build_object('request', request, 'email', r.email));
    return r.organization_id;
  end if;

  if r.kind = 'create' then
    insert into public.organizations (name, created_by) values (r.organization_name, r.user_id)
    returning id into org;
    insert into public.memberships (organization_id, user_id, role) values (org, r.user_id, 'admin');
    update public.access_requests
    set status = 'approved', organization_id = org, granted_role = 'admin', decided_at = now(),
        decided_by = (select auth.uid())
    where id = request;
    perform private.audit(org, 'organization.created',
      jsonb_build_object('name', r.organization_name, 'request', request, 'admin', r.email));
  else
    org := r.organization_id;
    insert into public.memberships (organization_id, user_id, role) values (org, r.user_id, member_role)
    on conflict (organization_id, user_id) do nothing;
    update public.access_requests
    set status = 'approved', granted_role = member_role, decided_at = now(), decided_by = (select auth.uid())
    where id = request;
    perform private.audit(org, 'member.set',
      jsonb_build_object('user_id', r.user_id, 'role', member_role, 'status', 'active', 'request', request));
  end if;
  return org;
end;
$$;

revoke all on function public.joinable_organizations(), public.request_to_join(uuid),
  public.request_organization(text), public.cancel_access_request(uuid),
  public.decide_access_request(uuid, boolean, text) from public, anon;
grant execute on function public.joinable_organizations(), public.request_to_join(uuid),
  public.request_organization(text), public.cancel_access_request(uuid),
  public.decide_access_request(uuid, boolean, text) to authenticated;

-- The requester's page waits for the decision without a reload.
alter publication supabase_realtime add table public.access_requests;
