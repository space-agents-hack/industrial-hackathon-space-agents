-- The platform layer (docs/adr/0004-platform-layer.md): organisations, roles, settings editable in
-- production, provider keys in Supabase Vault, and an audit log.
--
-- Who is who:
--   platform admin    operates the deployment; sees and manages every organisation. A row in
--                     private.platform_admins, which no API can write.
--   admin             manages one organisation: its people, settings and keys.
--   member            starts runs and decides approvals in their organisation.
--   viewer            reads their organisation's runs; changes nothing.
--
-- Every write that needs a role check goes through a `security definer` function below, which
-- checks the role and writes the audit row in the same transaction. Tables are read through RLS.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  -- Why this person has platform-wide power. Mandatory: in six months nobody will remember.
  note        text not null check (length(note) between 1 and 500),
  created_at  timestamptz not null default now()
);

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 200),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null
);

create table public.memberships (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  role             text not null check (role in ('admin', 'member', 'viewer')),
  -- Suspended keeps the history of who did what; deleting would orphan it.
  status           text not null default 'active' check (status in ('active', 'suspended')),
  created_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

-- Helpers for policies and functions. `security definer` so a policy can ask without the
-- question itself being filtered by RLS; `search_path = ''` so nothing can be shadowed.
create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.platform_admins where user_id = (select auth.uid()));
$$;

create function private.has_role(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (roles)
  );
$$;

-- Read access to an organisation: any active member, or a platform admin.
create function private.can_read(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin()
      or private.has_role(org, array['admin', 'member', 'viewer']);
$$;

-- Management of an organisation: its admins, or a platform admin.
create function private.can_manage(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() or private.has_role(org, array['admin']);
$$;

grant usage on schema private to authenticated, service_role;
revoke all on all functions in schema private from public;
grant execute on function private.is_platform_admin(), private.has_role(uuid, text[]),
  private.can_read(uuid), private.can_manage(uuid) to authenticated, service_role;

create table public.audit_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid references public.organizations (id) on delete cascade,
  actor            uuid references auth.users (id) on delete set null,
  action           text not null,
  -- Never a secret: keys appear as provider and last four characters only.
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index audit_events_org_idx on public.audit_events (organization_id, id desc);

create function private.audit(org uuid, action text, detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (organization_id, actor, action, detail)
  values (org, (select auth.uid()), action, coalesce(detail, '{}'::jsonb));
$$;

revoke all on function private.audit(uuid, text, jsonb) from public;

-- ------------------------------------------------------------------------------------------
-- Runs belong to an organisation. Existing data moves into one called "Default", and everyone
-- who could sign in before keeps the access they had: before this migration every signed-in
-- user saw every run and could do everything, so each becomes an admin of "Default" and a
-- platform admin. Remove what is no longer wanted from the admin page.
-- ------------------------------------------------------------------------------------------

alter table public.runs add column organization_id uuid references public.organizations (id) on delete cascade;

do $$
declare
  default_org uuid;
begin
  if exists (select 1 from auth.users) or exists (select 1 from public.runs) then
    insert into public.organizations (name) values ('Default') returning id into default_org;
    update public.runs set organization_id = default_org;
    insert into public.memberships (organization_id, user_id, role)
    select default_org, id, 'admin' from auth.users
    on conflict do nothing;
    insert into private.platform_admins (user_id, note)
    select id, 'Signed in before organisations existed (migration 20261014120000).' from auth.users
    on conflict do nothing;
  end if;
end;
$$;

alter table public.runs alter column organization_id set not null;
create index runs_org_created_idx on public.runs (organization_id, created_at desc);

-- A user starts a run by naming the task and the organisation, nothing else: the other columns
-- are the agent's. Before, every column was insertable (cosmetic, but wrong).
revoke insert on public.runs from authenticated;
grant insert (task, organization_id) on public.runs to authenticated;

-- Deleting a person after an event must work: their runs go with them, their decisions stay
-- with no name.
alter table public.runs drop constraint runs_created_by_fkey;
alter table public.runs add constraint runs_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete cascade;
alter table public.approvals drop constraint approvals_decided_by_fkey;
alter table public.approvals add constraint approvals_decided_by_fkey
  foreign key (decided_by) references auth.users (id) on delete set null;

drop policy "signed-in users read runs" on public.runs;
drop policy "signed-in users start runs as themselves" on public.runs;
drop policy "signed-in users read events" on public.run_events;
drop policy "signed-in users read approvals" on public.approvals;
drop policy "signed-in users decide pending approvals once" on public.approvals;

create policy "people read their organisation's runs"
on public.runs for select to authenticated
using (private.can_read(organization_id));

create policy "members start runs in their organisation, as themselves"
on public.runs for insert to authenticated
with check (
  created_by = (select auth.uid())
  and status = 'queued'
  and private.has_role(organization_id, array['admin', 'member'])
);

create policy "people read the events of runs they can read"
on public.run_events for select to authenticated
using (exists (select 1 from public.runs r where r.id = run_id));

create policy "people read the approvals of runs they can read"
on public.approvals for select to authenticated
using (exists (select 1 from public.runs r where r.id = run_id));

-- A viewer reads but does not decide.
create policy "members decide pending approvals once"
on public.approvals for update to authenticated
using (
  status = 'pending'
  and exists (
    select 1 from public.runs r
    where r.id = run_id and private.has_role(r.organization_id, array['admin', 'member'])
  )
)
with check (status in ('approved', 'denied') and decided_by = (select auth.uid()));

-- ------------------------------------------------------------------------------------------
-- Settings: the repository holds the defaults (agent/agent_service/settings.py); a row here
-- holds only what an organisation changed. A null column means "use the default".
-- ------------------------------------------------------------------------------------------

create table public.organization_settings (
  organization_id       uuid primary key references public.organizations (id) on delete cascade,
  model                 text check (model is null or length(model) between 1 and 200),
  max_model_requests    integer check (max_model_requests is null or max_model_requests between 1 and 200),
  monthly_cost_cap_usd  numeric(12, 2) check (monthly_cost_cap_usd is null or monthly_cost_cap_usd >= 0),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null
);

-- ------------------------------------------------------------------------------------------
-- Provider keys. The key itself lives in Supabase Vault, encrypted with a key that is not in
-- the database. This table holds what people may see: provider, last four characters, origin.
-- The browser never reads a key back; only the agent does, through a function only the secret
-- key may call.
-- ------------------------------------------------------------------------------------------

create table public.provider_connections (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  provider         text not null check (provider in ('anthropic', 'openai', 'openrouter', 'deepseek')),
  last4            text not null,
  source           text not null default 'pasted' check (source in ('pasted', 'openrouter_oauth')),
  secret_id        uuid not null,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  primary key (organization_id, provider)
);

alter table private.platform_admins enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.audit_events enable row level security;
alter table public.organization_settings enable row level security;
alter table public.provider_connections enable row level security;

revoke all on public.organizations, public.memberships, public.audit_events,
  public.organization_settings, public.provider_connections from anon, authenticated;

grant select on public.organizations, public.memberships, public.organization_settings,
  public.audit_events to authenticated;
-- Column grant: secret_id is the Vault handle and never leaves the database for a browser.
grant select (organization_id, provider, last4, source, created_at, created_by)
  on public.provider_connections to authenticated;

grant all on public.organizations, public.memberships, public.audit_events,
  public.organization_settings, public.provider_connections to service_role;
grant all on private.platform_admins to service_role;

create policy "people read the organisations they belong to"
on public.organizations for select to authenticated
using (private.can_read(id));

create policy "people read the members of their organisations"
on public.memberships for select to authenticated
using (private.can_read(organization_id));

create policy "people read their organisation's settings"
on public.organization_settings for select to authenticated
using (private.can_read(organization_id));

create policy "people see which providers are connected"
on public.provider_connections for select to authenticated
using (private.can_read(organization_id));

create policy "admins read their organisation's audit log"
on public.audit_events for select to authenticated
using (private.can_manage(organization_id));

-- ------------------------------------------------------------------------------------------
-- Functions the web calls as the signed-in user. Each checks the role, does the change and
-- writes the audit row together.
-- ------------------------------------------------------------------------------------------

-- What the signed-in person may do, for the web to shape its pages. The database still checks
-- every action on its own; this only decides what to show.
create function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'platform_admin', private.is_platform_admin(),
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role) order by o.created_at)
      from public.organizations o
      join public.memberships m on m.organization_id = o.id
      where m.user_id = (select auth.uid()) and m.status = 'active'
    ), '[]'::jsonb),
    -- A platform admin manages organisations they are not a member of.
    'all_organizations', case when private.is_platform_admin() then coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.created_at)
      from public.organizations o
    ), '[]'::jsonb) else '[]'::jsonb end
  );
$$;

create function public.create_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  if not private.is_platform_admin() then
    raise exception 'only a platform admin creates organisations' using errcode = '42501';
  end if;
  insert into public.organizations (name, created_by) values (org_name, (select auth.uid()))
  returning id into org;
  perform private.audit(org, 'organization.created', jsonb_build_object('name', org_name));
  return org;
end;
$$;

create function public.update_organization_settings(
  org uuid,
  new_model text,
  new_max_model_requests integer,
  new_monthly_cost_cap_usd numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation changes its settings' using errcode = '42501';
  end if;
  insert into public.organization_settings
    (organization_id, model, max_model_requests, monthly_cost_cap_usd, updated_at, updated_by)
  values (org, nullif(new_model, ''), new_max_model_requests, new_monthly_cost_cap_usd, now(), (select auth.uid()))
  on conflict (organization_id) do update set
    model = excluded.model,
    max_model_requests = excluded.max_model_requests,
    monthly_cost_cap_usd = excluded.monthly_cost_cap_usd,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
  perform private.audit(org, 'settings.updated', jsonb_build_object(
    'model', nullif(new_model, ''),
    'max_model_requests', new_max_model_requests,
    'monthly_cost_cap_usd', new_monthly_cost_cap_usd));
end;
$$;

-- The Vault secret goes with its connection row however the row goes: deleted by an admin, or
-- with its organisation (on delete cascade), which would otherwise leave keys behind in Vault.
create function private.delete_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

revoke all on function private.delete_vault_secret() from public;

create trigger provider_connections_delete_secret
after delete on public.provider_connections
for each row execute function private.delete_vault_secret();

create function public.set_provider_key(org uuid, key_provider text, api_key text, key_source text default 'pasted')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its keys' using errcode = '42501';
  end if;
  if length(coalesce(api_key, '')) < 16 or api_key ~ '\s' then
    raise exception 'that does not look like an API key' using errcode = '22023';
  end if;
  select secret_id into existing from public.provider_connections
  where organization_id = org and provider = key_provider;
  if existing is null then
    insert into public.provider_connections (organization_id, provider, last4, source, secret_id, created_by)
    values (org, key_provider, right(api_key, 4), key_source,
            vault.create_secret(api_key, format('provider:%s:%s', org, key_provider)),
            (select auth.uid()));
  else
    perform vault.update_secret(existing, api_key);
    update public.provider_connections
    set last4 = right(api_key, 4), source = key_source, created_at = now(), created_by = (select auth.uid())
    where organization_id = org and provider = key_provider;
  end if;
  perform private.audit(org, case when existing is null then 'provider.connected' else 'provider.rotated' end,
    jsonb_build_object('provider', key_provider, 'last4', right(api_key, 4), 'source', key_source));
end;
$$;

create function public.delete_provider_key(org uuid, key_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its keys' using errcode = '42501';
  end if;
  -- The trigger above deletes the Vault secret.
  delete from public.provider_connections
  where organization_id = org and provider = key_provider
  returning secret_id into existing;
  if existing is not null then
    perform private.audit(org, 'provider.deleted', jsonb_build_object('provider', key_provider));
  end if;
end;
$$;

-- Adds or updates a person in an organisation. The auth user is created by the agent service
-- (it holds the key that may create users); this only gives them a place and a role.
create function public.set_member(org uuid, member uuid, member_role text, member_status text default 'active')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation manages its people' using errcode = '42501';
  end if;
  if member_role not in ('admin', 'member', 'viewer') or member_status not in ('active', 'suspended') then
    raise exception 'unknown role or status' using errcode = '22023';
  end if;
  -- An organisation must keep at least one active admin, or nobody can manage it again.
  if not (member_role = 'admin' and member_status = 'active') and not exists (
    select 1 from public.memberships
    where organization_id = org and role = 'admin' and status = 'active' and user_id <> member
  ) and exists (
    select 1 from public.memberships
    where organization_id = org and user_id = member and role = 'admin' and status = 'active'
  ) then
    raise exception 'this would leave the organisation without an admin' using errcode = '23514';
  end if;
  insert into public.memberships (organization_id, user_id, role, status)
  values (org, member, member_role, member_status)
  on conflict (organization_id, user_id) do update set role = excluded.role, status = excluded.status;
  perform private.audit(org, 'member.set', jsonb_build_object(
    'user_id', member, 'role', member_role, 'status', member_status));
end;
$$;

-- People of an organisation with their email, for the admin page. auth.users is not readable by
-- the browser, so this function returns only these three fields, and only to managers.
create function public.organization_people(org uuid)
returns table (user_id uuid, email text, role text, status text, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation sees its people' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.status, u.last_sign_in_at
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = org
    order by u.email;
end;
$$;

-- May the signed-in person set a new password for this user? Only if they manage every
-- organisation the user belongs to (or are a platform admin). Otherwise an admin of one client
-- could take over a person who is also an admin elsewhere by resetting their password.
create function public.can_reset_password(member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin() or (
    exists (select 1 from public.memberships where user_id = member)
    and not exists (
      select 1 from public.memberships m
      where m.user_id = member and not private.can_manage(m.organization_id)
    )
    and not exists (select 1 from private.platform_admins where user_id = member)
  );
$$;

-- What an organisation has spent, by month, from the cost the agent records on each run.
create function public.organization_usage(org uuid, months integer default 6)
returns table (month date, runs bigint, cost_usd numeric, tokens bigint)
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
    select date_trunc('month', r.created_at at time zone 'utc')::date,
           count(*),
           coalesce(sum((r.usage ->> 'cost_usd')::numeric), 0),
           coalesce(sum(coalesce((r.usage ->> 'input_tokens')::bigint, 0)
                      + coalesce((r.usage ->> 'output_tokens')::bigint, 0)), 0)::bigint
    from public.runs r
    where r.organization_id = org
      -- UTC months, the same as the agent's monthly cap (agent_service/store.py, month_cost):
      -- in the session's time zone the page and the cap would disagree near a month's edge.
      and r.created_at >= (date_trunc('month', now() at time zone 'utc')
                           - make_interval(months => greatest(months, 1) - 1)) at time zone 'utc'
    group by 1
    order by 1 desc;
end;
$$;

revoke all on function public.my_access(), public.create_organization(text),
  public.update_organization_settings(uuid, text, integer, numeric),
  public.set_provider_key(uuid, text, text, text), public.delete_provider_key(uuid, text),
  public.set_member(uuid, uuid, text, text), public.organization_people(uuid),
  public.organization_usage(uuid, integer), public.can_reset_password(uuid) from public, anon;
grant execute on function public.my_access(), public.create_organization(text),
  public.update_organization_settings(uuid, text, integer, numeric),
  public.set_provider_key(uuid, text, text, text), public.delete_provider_key(uuid, text),
  public.set_member(uuid, uuid, text, text), public.organization_people(uuid),
  public.organization_usage(uuid, integer), public.can_reset_password(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------
-- Functions only the agent (secret key) may call.
-- ------------------------------------------------------------------------------------------

create function public.read_provider_key(org uuid, key_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from public.provider_connections c
  join vault.decrypted_secrets s on s.id = c.secret_id
  where c.organization_id = org and c.provider = key_provider;
$$;

-- The first people of a deployment: puts a user in the first organisation (created if there is
-- none) with a role, and optionally makes them a platform admin. Used by scripts/create-user.sh.
create function public.bootstrap_member(member uuid, member_role text, make_platform_admin boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select id into org from public.organizations order by created_at limit 1;
  if org is null then
    insert into public.organizations (name) values ('Default') returning id into org;
  end if;
  insert into public.memberships (organization_id, user_id, role)
  values (org, member, member_role)
  on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active';
  if make_platform_admin then
    insert into private.platform_admins (user_id, note)
    values (member, 'Created by scripts/create-user.sh with --platform-admin.')
    on conflict do nothing;
  end if;
  return org;
end;
$$;

revoke all on function public.read_provider_key(uuid, text),
  public.bootstrap_member(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.read_provider_key(uuid, text),
  public.bootstrap_member(uuid, text, boolean) to service_role;

alter publication supabase_realtime add table public.organization_settings, public.provider_connections;
