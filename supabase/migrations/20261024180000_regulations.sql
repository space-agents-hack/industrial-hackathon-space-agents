-- The regulation library (docs/regulations-store.md): which UN Regulations exist, which versions of
-- each are stored, and the imports that put them there.
--
-- How a library gets filled: an admin uploads an index file (the challenge's
-- regulations/index.json format) in the web app. create_regulation_import stores it as a job; the
-- agent then downloads each PDF, checks its sha256, puts it in the `regulations` bucket and records
-- the version with record_regulation_version. The agent works in slices that fit one function
-- call, so a job can be `paused` between slices; the web page sends it back to the agent.
--
-- Each organisation has its own library (Ramón, 2026-10-24): what one admin imports, everyone in
-- that organisation sees, and no other organisation does. Two clients may cite different sets or
-- versions, and a client's set may not be public. The cost is a copy of the same UNECE PDFs per
-- organisation, about 214 MB for the challenge's set.
--
-- Who can do what, per organisation:
--   any member, viewer      reads the library (regulations, versions, PDFs) and the imports.
--   admin                   starts and cancels imports.
--   platform admin          the same as an admin, in every organisation.
--   the agent (secret key)  everything else. Nobody else writes the library.

create table public.regulations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- Exactly as the index writes it ("UN R10", "UN GTR 9"): Certivity's validate.py checks a
  -- submission against that file, so a normalised copy would fail it (docs/se SYS-5, IF-3).
  code        text not null check (length(code) between 1 and 100),
  -- The folder in the bucket ("UN_R10"). Derived from `code` by the agent; kept in a column so a
  -- change to that rule cannot move files that are already stored.
  slug        text not null check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'),
  kind        text not null check (kind in ('UN R', 'UN GTR', 'other')),
  title       text check (length(title) <= 500),
  source_url  text check (length(source_url) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, slug)
);

create table public.regulation_imports (
  id           uuid primary key default gen_random_uuid(),
  -- The library this import fills.
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
  -- The uploaded file's name, for the person reading the history.
  source_name  text not null check (length(source_name) between 1 and 255),
  -- The uploaded file as it was. It holds temporary download links with their signatures, so no
  -- browser role can read this column (grants below).
  index        jsonb not null,
  error        text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null,
  -- Doubles as the heartbeat: the agent touches the row after each file, and a running import that
  -- has not been touched for a while is taken over by the next call (agent settings).
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- One import at a time per library. Two imports of the same regulation would race to decide which
-- version is "latest"; refusing the second is simpler than resolving that.
create unique index regulation_imports_one_active
on public.regulation_imports (organization_id) where status in ('queued', 'running', 'paused');

create index regulation_imports_org_created_idx on public.regulation_imports (organization_id, created_at desc);

-- One row per PDF in the uploaded index, written by the agent when it first reads the index.
create table public.regulation_import_files (
  import_id        uuid not null references public.regulation_imports (id) on delete cascade,
  position         integer not null check (position >= 0),
  regulation_code  text not null,
  -- What record_regulation_version needs, copied from the index so a later slice does not have to
  -- read the index again.
  regulation_title text,
  source_url       text,
  version_label    text not null,
  role             text check (role in ('base', 'latest')),
  version_status   text,
  version_title    text,
  file_name        text not null,
  -- Temporary signed link. Never granted to a browser role.
  url              text not null,
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       bigint check (size_bytes > 0),
  -- stored: downloaded and uploaded now. unchanged: the library already had this exact file.
  status           text not null default 'pending' check (status in ('pending', 'stored', 'unchanged', 'failed')),
  error            text,
  updated_at       timestamptz not null default now(),
  primary key (import_id, position)
);

create table public.regulation_versions (
  id               uuid primary key default gen_random_uuid(),
  regulation_id    uuid not null references public.regulations (id) on delete cascade,
  -- The regulation's organisation, repeated so the read policy needs no join.
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- The identity of a version, and what a submission cites as `version` ("7.3.0").
  version_label    text not null check (version_label ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  -- A position in the last index that mentioned this version, not an identity: when an import
  -- names a newer "latest", the role moves to it and the older version keeps its row with role null.
  role             text check (role in ('base', 'latest')),
  status           text check (length(status) <= 50),
  title            text check (length(title) <= 500),
  -- The name the index gave the file, for tracing it back to the source.
  file_name        text not null check (length(file_name) between 1 and 255),
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       bigint not null check (size_bytes > 0),
  -- In the `regulations` bucket: <organization_id>/<slug>/<version_label>/<slug>_<version_label>.pdf.
  -- The organisation first, so the storage policy can read it from the path, as for case-files. By
  -- version, not by role, so a new "latest" never overwrites the file an older row points to.
  pdf_path         text not null unique,
  -- Filled by the text extraction, which is not built yet. The Markdown sits next to the PDF and
  -- the pictures in an images/ folder beside it.
  md_path          text,
  page_count       integer check (page_count > 0),
  extracted_at     timestamptz,
  last_import_id   uuid references public.regulation_imports (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (regulation_id, version_label)
);

create unique index regulation_versions_one_per_role
on public.regulation_versions (regulation_id, role) where role is not null;

create trigger regulations_set_updated_at
before update on public.regulations
for each row execute function public.set_updated_at();

create trigger regulation_imports_set_updated_at
before update on public.regulation_imports
for each row execute function public.set_updated_at();

create trigger regulation_import_files_set_updated_at
before update on public.regulation_import_files
for each row execute function public.set_updated_at();

create trigger regulation_versions_set_updated_at
before update on public.regulation_versions
for each row execute function public.set_updated_at();

alter table public.regulations enable row level security;
alter table public.regulation_versions enable row level security;
alter table public.regulation_imports enable row level security;
alter table public.regulation_import_files enable row level security;

revoke all on public.regulations, public.regulation_versions, public.regulation_imports,
  public.regulation_import_files from anon, authenticated;

grant select on public.regulations, public.regulation_versions to authenticated;
-- Column grants: `index` and `url` carry signed download links.
grant select (id, organization_id, status, source_name, error, created_at, created_by, updated_at,
  finished_at)
  on public.regulation_imports to authenticated;
grant select (import_id, position, regulation_code, version_label, role, file_name, size_bytes,
  status, error, updated_at)
  on public.regulation_import_files to authenticated;

grant all on public.regulations, public.regulation_versions, public.regulation_imports,
  public.regulation_import_files to service_role;

create policy "people read their organisation's regulation library"
on public.regulations for select to authenticated
using (private.can_read(organization_id));

create policy "people read their organisation's regulation versions"
on public.regulation_versions for select to authenticated
using (private.can_read(organization_id));

create policy "people read their organisation's imports"
on public.regulation_imports for select to authenticated
using (private.can_read(organization_id));

create policy "people read the files of their organisation's imports"
on public.regulation_import_files for select to authenticated
using (exists (
  select 1 from public.regulation_imports i
  where i.id = import_id and private.can_read(i.organization_id)
));

-- ------------------------------------------------------------------------------------------
-- The bucket. Private: a PDF is reached through a signed link the web makes as the signed-in
-- person, which the policy on storage.objects allows. 50 MB per file is the free plan's limit;
-- the largest PDF of the challenge is about 16 MB. On conflict it is made private and limited
-- anyway, as for case-files: on the hosted project it may have been created by hand.
-- ------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('regulations', 'regulations', false, 52428800,
        array['application/pdf', 'text/markdown', 'application/json', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "people read their organisation's regulation files"
on storage.objects for select to authenticated
using (
  bucket_id = 'regulations'
  and private.can_read(private.path_organization(name))
);

-- ------------------------------------------------------------------------------------------
-- Functions
-- ------------------------------------------------------------------------------------------

-- An admin starts an import into their organisation's library. The shape of each entry is checked
-- by the agent, which says exactly what is wrong; here only what keeps a broken upload out.
create function public.create_regulation_import(org uuid, source_name text, regulation_index jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  job uuid;
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation imports regulations' using errcode = '42501';
  end if;
  if jsonb_typeof(regulation_index) is distinct from 'array' or jsonb_array_length(regulation_index) = 0 then
    raise exception 'the index must be a non-empty list of regulations' using errcode = '22023';
  end if;
  -- The challenge's index is about 60 KB. 2 MB leaves room for a much larger library and keeps a
  -- wrong file (a PDF renamed .json, a database dump) out.
  if octet_length(regulation_index::text) > 2000000 then
    raise exception 'the index is larger than 2 MB' using errcode = '22023';
  end if;
  if exists (select 1 from public.regulation_imports i
             where i.organization_id = org and i.status in ('queued', 'running', 'paused')) then
    raise exception 'another import is still in progress; let it finish or cancel it first'
      using errcode = '55000';
  end if;

  insert into public.regulation_imports (organization_id, source_name, index, created_by)
  values (org, source_name, regulation_index, (select auth.uid()))
  returning id into job;
  perform private.audit(org, 'regulations.import_started', jsonb_build_object(
    'import_id', job, 'source_name', source_name, 'entries', jsonb_array_length(regulation_index)));
  return job;
exception
  -- Two admins pressing Import at the same moment: the unique index decides, and the loser gets
  -- the same sentence as above instead of a constraint name.
  when unique_violation then
    raise exception 'another import is still in progress; let it finish or cancel it first'
      using errcode = '55000';
end;
$$;

-- Stops an import between two files. Files already stored stay in the library.
create function public.cancel_regulation_import(job uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select organization_id into org from public.regulation_imports where id = job;
  if org is null or not private.can_manage(org) then
    raise exception 'only an admin of this organisation cancels its imports' using errcode = '42501';
  end if;
  update public.regulation_imports
  set status = 'cancelled', finished_at = now(), error = 'Cancelled from the app.'
  where id = job and status in ('queued', 'running', 'paused');
  if not found then
    raise exception 'this import is not in progress' using errcode = '55000';
  end if;
  perform private.audit(org, 'regulations.import_cancelled', jsonb_build_object('import_id', job));
end;
$$;

-- The agent records one stored version: the regulation, the version and, if the index gave it a
-- role, the move of that role from whichever version had it. In one transaction, so the library
-- never shows two "latest" versions or a version without its regulation.
-- Parameters carry a p_ prefix because most of them share a name with a column.
create function public.record_regulation_version(
  p_organization_id uuid,
  p_import_id      uuid,
  p_code           text,
  p_slug           text,
  p_kind           text,
  p_title          text,
  p_source_url     text,
  p_version_label  text,
  p_role           text,
  p_status         text,
  p_version_title  text,
  p_file_name      text,
  p_sha256         text,
  p_size_bytes     bigint,
  p_pdf_path       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  reg uuid;
  ver uuid;
begin
  insert into public.regulations (organization_id, code, slug, kind, title, source_url)
  values (p_organization_id, p_code, p_slug, p_kind, p_title, p_source_url)
  on conflict on constraint regulations_organization_id_code_key do update
    set title = coalesce(excluded.title, public.regulations.title),
        source_url = coalesce(excluded.source_url, public.regulations.source_url)
  returning id into reg;

  if p_role is not null then
    update public.regulation_versions
    set role = null
    where regulation_id = reg and role = p_role and version_label <> p_version_label;
  end if;

  insert into public.regulation_versions as v (regulation_id, organization_id, version_label, role,
    status, title, file_name, sha256, size_bytes, pdf_path, last_import_id)
  values (reg, p_organization_id, p_version_label, p_role, p_status, p_version_title,
    p_file_name, p_sha256, p_size_bytes, p_pdf_path, p_import_id)
  on conflict on constraint regulation_versions_regulation_id_version_label_key do update
    set role = excluded.role,
        status = excluded.status,
        title = excluded.title,
        file_name = excluded.file_name,
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        pdf_path = excluded.pdf_path,
        last_import_id = excluded.last_import_id,
        -- A different file is a different text: whatever was extracted from the old one is stale.
        md_path = case when v.sha256 = excluded.sha256 then v.md_path end,
        page_count = case when v.sha256 = excluded.sha256 then v.page_count end,
        extracted_at = case when v.sha256 = excluded.sha256 then v.extracted_at end
  returning id into ver;
  return ver;
end;
$$;

revoke all on function public.create_regulation_import(uuid, text, jsonb),
  public.cancel_regulation_import(uuid),
  public.record_regulation_version(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.create_regulation_import(uuid, text, jsonb),
  public.cancel_regulation_import(uuid) to authenticated;
grant execute on function
  public.record_regulation_version(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, bigint, text)
  to service_role;
