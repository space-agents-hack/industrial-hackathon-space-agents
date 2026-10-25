-- Read-only organisations (SYS-47, #59): an organisation people can explore and nobody, whatever
-- their role, can change or make spend model money. Made for the Certivity judges' demo account
-- (Ramón, 2026-10-25: "No admin privileges here and freezed, no LLM calls").
--
-- Why the role check and not a check in every policy: every write a browser can make, in tables,
-- in `security definer` functions and in Storage, already asks private.has_role (or can_manage,
-- which asks it). Making every member of a read-only organisation count as a viewer there covers
-- all of them at once, including the ones added after this migration. A check per policy would
-- be one more thing each new table has to remember.
--
-- What it does NOT cover, on purpose:
--   - a platform admin still manages the organisation (can_manage), so people can be added and
--     removed without unfreezing it. The agent refuses model calls for it regardless of who asks
--     (agent_service/api.py).
--   - the agent writes with the secret key, past RLS: it has its own check, for the same reason.
--   - nothing in the browser sets the flag. It is set from SQL by whoever operates the
--     deployment (scripts/demo-org.sql), so no admin can freeze or unfreeze it by mistake.

alter table public.organizations add column read_only boolean not null default false;

comment on column public.organizations.read_only is
  'Members count as viewers and the agent calls no model for it (SYS-47). Set from SQL only.';

create or replace function private.has_role(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (case when o.read_only then 'viewer' else m.role end) = any (roles)
  );
$$;

-- The same rule for what the web shows: the role a person has in effect, plus the flag, so a page
-- can say why there is nothing to press.
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'platform_admin', private.is_platform_admin(),
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name,
        'role', case when o.read_only then 'viewer' else m.role end,
        'read_only', o.read_only) order by o.created_at)
      from public.organizations o
      join public.memberships m on m.organization_id = o.id
      where m.user_id = (select auth.uid()) and m.status = 'active'
    ), '[]'::jsonb),
    'all_organizations', case when private.is_platform_admin() then coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'read_only', o.read_only)
                       order by o.created_at)
      from public.organizations o
    ), '[]'::jsonb) else '[]'::jsonb end
  );
$$;

-- ------------------------------------------------------------------------------------------
-- Files to copy inside Storage, queued from SQL and done by the agent. A copy of an organisation
-- (scripts/demo-org.sql) is rows and files: SQL can copy the rows, but only the Storage API can
-- copy a file, and only the agent holds the key it needs. The release workflow holds the database
-- password, not that key (docs/deploy.md), so SQL writes down what to copy and the agent does it
-- (POST /admin/storage-copies/advance). The caller never names a path: only someone who can
-- write this table, which no browser role can, decides what is copied.
-- ------------------------------------------------------------------------------------------

create table public.storage_copies (
  id               bigint generated always as identity primary key,
  -- The organisation the copy is for, so its rows go when it does.
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  bucket_id        text not null check (bucket_id in ('case-files', 'regulations')),
  source_path      text not null check (length(source_path) between 1 and 1024),
  target_path      text not null check (length(target_path) between 1 and 1024),
  created_at       timestamptz not null default now(),
  copied_at        timestamptz,
  -- The last failure, for the person reading the workflow's summary. A failed copy stays pending
  -- and is tried again by the next call.
  error            text,
  unique (bucket_id, target_path),
  -- A copy lands in its own organisation's folder: the storage policies read the organisation
  -- from the first segment of the path.
  check (split_part(target_path, '/', 1) = organization_id::text),
  check (source_path <> target_path)
);

create index storage_copies_pending_idx on public.storage_copies (id) where copied_at is null;

alter table public.storage_copies enable row level security;
revoke all on public.storage_copies from anon, authenticated;
grant all on public.storage_copies to service_role;
