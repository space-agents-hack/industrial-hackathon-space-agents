-- Case files: what an engineer uploads to start a run (issue #8; docs/se IF-1).
--
-- The bytes live in a private Storage bucket, not in a table: a Vercel function refuses request
-- bodies over 4.5 MB, so the browser uploads each file straight to Storage as the signed-in user,
-- and Postgres only keeps one row per file. Bytes in a table would also count against the
-- database size and ride along with every query on it.
--
-- Who writes what:
--   browser (as the user)   uploads objects under {organization_id}/{upload_id}/{filename}.
--   web (as the user)       public.start_run(): the run and its run_files rows, in one transaction.
--   agent (secret key)      reads the rows and downloads the objects.
--
-- What this does NOT do: delete objects when a run is deleted. Storage objects do not cascade
-- from rows; scripts/purge-challenge-data.sh empties the bucket on its own.

-- On conflict the bucket is made private and limited anyway: on the hosted project it may already
-- exist, created by hand in the dashboard, and a public bucket would serve every client's drawings
-- to anyone with the URL.
insert into storage.buckets (id, name, public, file_size_limit)
values ('case-files', 'case-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- The organisation a Storage path belongs to: its first segment, or null when that is not a uuid.
-- A cast inside a policy would raise on a malformed path instead of refusing it.
create function private.path_organization(path text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(path, '/', 1)::uuid
  end;
$$;

revoke all on function private.path_organization(text) from public;
grant execute on function private.path_organization(text) to authenticated, service_role;

-- Uploading needs the member role, as starting a run does; reading needs any role, as reading a
-- run does. Nobody but the agent's secret key updates or deletes: an uploaded case is evidence.
create policy "members upload case files to their organisation"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'case-files'
  and private.has_role(private.path_organization(name), array['admin', 'member'])
);

create policy "people read their organisation's case files"
on storage.objects for select to authenticated
using (
  bucket_id = 'case-files'
  and private.can_read(private.path_organization(name))
);

-- The accepted formats are this check, so the web's picker and the agent's readers cannot drift
-- apart unnoticed: the database refuses what neither side was written for. The format is the
-- normalised extension (jpg -> jpeg, stp -> step, igs -> iges), not the browser's media type,
-- because browsers report CAD files as "" or application/octet-stream.
create table public.run_files (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.runs (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  created_at       timestamptz not null default now(),
  storage_path     text not null unique check (length(storage_path) between 1 and 1024),
  filename         text not null check (length(filename) between 1 and 255),
  format           text not null
                   check (format in ('md', 'txt', 'csv', 'json', 'png', 'jpeg', 'webp', 'pdf',
                                     'docx', 'xlsx', 'step', 'iges', 'stl')),
  -- As the browser reported it; informative only.
  media_type       text check (media_type is null or length(media_type) <= 255),
  bytes            bigint not null check (bytes between 1 and 26214400),
  sha256           text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);

create index run_files_run_id_idx on public.run_files (run_id);

alter table public.run_files enable row level security;

revoke all on public.run_files from anon, authenticated;
grant select on public.run_files to authenticated;
grant insert (run_id, organization_id, storage_path, filename, format, media_type, bytes, sha256)
  on public.run_files to authenticated;
grant all on public.run_files to service_role;

create policy "people read the files of runs they can read"
on public.run_files for select to authenticated
using (private.can_read(organization_id));

-- A file is attached by the person who started the run, before the agent picks it up, from
-- their own organisation's folder, and only if the object was really uploaded. Without the last
-- condition a run could name a path that does not exist and fail later, inside the agent.
create policy "members attach uploaded files to their own queued runs"
on public.run_files for insert to authenticated
with check (
  private.has_role(organization_id, array['admin', 'member'])
  and private.path_organization(storage_path) = organization_id
  and exists (
    select 1 from public.runs r
    where r.id = run_id
      and r.organization_id = run_files.organization_id
      and r.created_by = (select auth.uid())
      and r.status = 'queued'
  )
  and exists (
    select 1 from storage.objects o
    where o.bucket_id = 'case-files' and o.name = storage_path
  )
);

-- Not added to the realtime publication on purpose: file lists stay out of every live update.

-- A run and its files in one transaction, as the caller (security invoker, so the policies above
-- apply). Two inserts from the web would leave a run without its files if the second failed, and
-- the agent would then start it on the note alone.
create function public.start_run(p_task text, p_organization_id uuid, p_files jsonb default '[]')
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'files must be a JSON array' using errcode = '22023';
  end if;
  -- The same limit the web shows. More files than this do not fit what the agent sends the model.
  if jsonb_array_length(p_files) > 20 then
    raise exception 'at most 20 files per run' using errcode = '22023';
  end if;

  insert into public.runs (task, organization_id)
  values (p_task, p_organization_id)
  returning id into new_id;

  insert into public.run_files
    (run_id, organization_id, storage_path, filename, format, media_type, bytes, sha256)
  select new_id, p_organization_id, f ->> 'storage_path', f ->> 'filename', f ->> 'format',
         nullif(f ->> 'media_type', ''), (f ->> 'bytes')::bigint, nullif(f ->> 'sha256', '')
  from jsonb_array_elements(p_files) as f;

  return new_id;
end;
$$;

revoke all on function public.start_run(text, uuid, jsonb) from public, anon;
grant execute on function public.start_run(text, uuid, jsonb) to authenticated;

-- The agent records one event per case file: what was read, and what was skipped or truncated.
alter table public.run_events drop constraint run_events_kind_check;
alter table public.run_events add constraint run_events_kind_check
  check (kind in ('status', 'text', 'tool_call', 'tool_result',
                  'approval_requested', 'approval_resolved', 'error', 'case_file'));
