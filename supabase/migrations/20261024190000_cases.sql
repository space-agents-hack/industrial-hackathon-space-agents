-- Organisation -> projects -> cases, and each case's files parsed once into stored blocks
-- (ADR-0006; docs/se SYS-24, SYS-27, IF-1, IF-2; issue #8).
--
-- Why cases are rows and not just a run's attachments: several engineers of one organisation work
-- on the same part of a car, and a case is read many times (one run per regulation set, one per
-- prompt change). Parsing it once, at upload, means every run reads the same text with the same
-- page numbers, and a slow PDF or a model transcription is paid for once.
--
-- Who writes what:
--   browser (as the user)  creates projects and cases; uploads objects to {org}/{case_id}/...;
--                          inserts case_files rows for objects that exist.
--   agent (secret key)     parses: sets case_files.status and writes case_file_blocks, plus the
--                          images it renders under {org}/{case_id}/blocks/.
--
-- Every role of the organisation reads everything here; admins and members create. There are no
-- per-project permissions (ADR-0006). run_files and start_run() (20261024160000) keep working
-- until the web stops using them.

create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 200),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, name),
  -- Target of the composite keys below: a case cannot sit in another organisation's project.
  unique (id, organization_id)
);

create table public.cases (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null,
  -- Repeated from the project so every policy reads one column, with no join.
  organization_id  uuid not null,
  name             text not null check (length(btrim(name)) between 1 and 200),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (project_id, name),
  unique (id, organization_id),
  foreign key (project_id, organization_id)
    references public.projects (id, organization_id) on delete cascade
);

create index cases_organization_idx on public.cases (organization_id, created_at desc);

-- A run may be about a case. Null for runs started the old way. The composite key keeps a run
-- and its case in the same organisation; deleting a case keeps its runs as history.
alter table public.runs add column case_id uuid;
alter table public.runs add constraint runs_case_fkey
  foreign key (case_id, organization_id)
  references public.cases (id, organization_id) on delete set null (case_id);
create index runs_case_idx on public.runs (case_id) where case_id is not null;

grant insert (case_id) on public.runs to authenticated;

create table public.case_files (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null,
  organization_id  uuid not null,
  -- Upload order, explicit. Rows inserted in one transaction share created_at, so ordering by it
  -- falls back to the random id and the spec can end up after a large CSV.
  position         integer not null default 0 check (position >= 0),
  storage_path     text not null unique check (length(storage_path) between 1 and 1024),
  filename         text not null check (length(filename) between 1 and 255),
  -- Same list as run_files.format, for the same reason: the database refuses what no reader handles.
  format           text not null
                   check (format in ('md', 'txt', 'csv', 'json', 'png', 'jpeg', 'webp', 'pdf',
                                     'docx', 'xlsx', 'step', 'iges', 'stl')),
  media_type       text check (media_type is null or length(media_type) <= 255),
  bytes            bigint not null check (bytes between 1 and 26214400),
  sha256           text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status           text not null default 'pending'
                   check (status in ('pending', 'parsing', 'parsed', 'failed')),
  -- What the parser could not do, and what it did instead (rendered pages, model transcription).
  notes            jsonb not null default '[]'::jsonb,
  error            text check (error is null or length(error) <= 2000),
  pages            integer check (pages is null or pages >= 0),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  parsed_at        timestamptz,
  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade
);

create index case_files_case_idx on public.case_files (case_id, position);

create trigger case_files_set_updated_at
before update on public.case_files
for each row execute function public.set_updated_at();

-- The standard shape every reader produces (agent/agent_service/domain/ingest.py, Block): text or
-- an image, with its page where the format has pages, and the parser that made it.
create table public.case_file_blocks (
  id               bigint generated always as identity primary key,
  file_id          uuid not null references public.case_files (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  seq              integer not null check (seq >= 0),
  kind             text not null check (kind in ('text', 'image')),
  page             integer check (page is null or page >= 1),
  label            text not null default '' check (length(label) <= 200),
  text             text,
  -- An image's object in the case-files bucket: the uploaded file itself, or a page the agent
  -- rendered.
  image_path       text check (image_path is null or length(image_path) <= 1024),
  media_type       text check (media_type is null or length(media_type) <= 255),
  -- "pypdf", "pdfium-render", "model:anthropic:claude-haiku-5-5"... A block a model wrote is
  -- marked so a citation of it can be checked against the source.
  parser           text not null check (length(parser) between 1 and 200),
  created_at       timestamptz not null default now(),
  unique (file_id, seq),
  check ((kind = 'text') = (text is not null)),
  check ((kind = 'image') = (image_path is not null))
);

alter table public.projects enable row level security;
alter table public.cases enable row level security;
alter table public.case_files enable row level security;
alter table public.case_file_blocks enable row level security;

revoke all on public.projects, public.cases, public.case_files, public.case_file_blocks
  from anon, authenticated;

grant select on public.projects, public.cases, public.case_files, public.case_file_blocks
  to authenticated;
-- The id may come from the browser: it builds the case's Storage folder before the first upload.
grant insert (id, organization_id, name) on public.projects to authenticated;
grant insert (id, project_id, organization_id, name) on public.cases to authenticated;
grant insert (case_id, organization_id, position, storage_path, filename, format, media_type,
              bytes, sha256)
  on public.case_files to authenticated;

grant all on public.projects, public.cases, public.case_files, public.case_file_blocks
  to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy "people read their organisation's projects"
on public.projects for select to authenticated
using (private.can_read(organization_id));

create policy "members create projects in their organisation"
on public.projects for insert to authenticated
with check (
  private.has_role(organization_id, array['admin', 'member'])
  and created_by = (select auth.uid())
);

create policy "people read their organisation's cases"
on public.cases for select to authenticated
using (private.can_read(organization_id));

create policy "members create cases in their organisation"
on public.cases for insert to authenticated
with check (
  private.has_role(organization_id, array['admin', 'member'])
  and created_by = (select auth.uid())
);

create policy "people read their organisation's case files"
on public.case_files for select to authenticated
using (private.can_read(organization_id));

-- A file row is accepted only for an object really uploaded into that case's folder; otherwise a
-- case could list a file that does not exist and fail later, inside the agent.
create policy "members add uploaded files to their organisation's cases"
on public.case_files for insert to authenticated
with check (
  private.has_role(organization_id, array['admin', 'member'])
  and created_by = (select auth.uid())
  and private.path_organization(storage_path) = organization_id
  and split_part(storage_path, '/', 2) = case_id::text
  and exists (
    select 1 from storage.objects o
    where o.bucket_id = 'case-files' and o.name = storage_path
  )
);

create policy "people read the parsed content of their organisation's files"
on public.case_file_blocks for select to authenticated
using (private.can_read(organization_id));

-- The case page shows each file's parse status as it changes. Blocks stay out: they are large.
alter publication supabase_realtime add table public.case_files;
