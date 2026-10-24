-- Superseded paragraphs that no requirement cites are deleted, and a requirement whose paragraph
-- was superseded without a match says so (SYS-34; Ramón, 2026-10-24, on the two open points of
-- 20261024270000_superseded_paragraphs.sql).
--
-- Why purge: superseded rows exist for the requirements written from them. One nobody cites is
-- only storage, and a full re-split of the challenge library supersedes about 48,000 rows (one
-- split measured 68 MB with indexes, against 500 MB on Supabase's free plan).
--
-- Why a requirement column: before this, the only sign of a changed paragraph was that the check
-- did not find the cited row among the current ones, and only when the check ran on that run.
-- `paragraph_superseded_at` can be queried across runs and cases, and says when it happened.

-- ------------------------------------------------------------------------------------------
-- Requirements on a superseded paragraph
-- ------------------------------------------------------------------------------------------

-- When the paragraph this requirement cites was superseded and the new split had no paragraph
-- with the same label and text. Null while the cited paragraph is current. Set and cleared only by
-- the functions below; the requirement's own citation fields are never touched.
alter table public.requirements add column paragraph_superseded_at timestamptz;

-- Requirements already on a superseded row since 20261024270000, and those whose row was deleted
-- before it (null link, version still there): both cite text the library no longer has.
update public.requirements r
set paragraph_superseded_at = p.superseded_at
from public.regulation_paragraphs p
where p.id = r.paragraph_id and p.superseded_at is not null;
update public.requirements
set paragraph_superseded_at = now()
where paragraph_id is null and version_id is not null;

-- ------------------------------------------------------------------------------------------
-- Purge
-- ------------------------------------------------------------------------------------------

-- The purge reads superseded rows only.
create index regulation_paragraphs_superseded_idx
on public.regulation_paragraphs (organization_id, superseded_at) where superseded_at is not null;

-- Deletes the organisation's superseded paragraphs that no requirement cites, once they have been
-- superseded for an hour. The hour is for a run that read the paragraphs just before a re-split:
-- the writer stores requirements with the paragraph ids it read, and a deleted id would fail that
-- insert (foreign key). A run's work between reading and writing is one tool call, bounded by
-- RUN_TIMEOUT_S (770 s by default). Returns how many rows went.
create function private.purge_superseded_regulation_paragraphs(p_organization_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.regulation_paragraphs p
    where p.organization_id = p_organization_id
      and p.superseded_at < now() - interval '1 hour'
      and not exists (select 1 from public.requirements r where r.paragraph_id = p.id)
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function private.purge_superseded_regulation_paragraphs(uuid)
  from public, anon, authenticated;

-- As in 20261024270000, plus: the requirements on the superseded rows are flagged. The relink
-- trigger clears the flag again for every requirement whose text comes back in the new split, in
-- the same transaction, so after replace_regulation_paragraphs() only the changed ones keep it.
-- A different file under a version, or a failed split, flags all of its requirements until the
-- next split brings their text back.
create or replace function private.supersede_regulation_paragraphs(p_version_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  with gone as (
    update public.regulation_paragraphs
    set superseded_at = now()
    where version_id = p_version_id and superseded_at is null
    returning id, superseded_at
  ),
  keys as (
    delete from public.regulation_paragraph_keys k
    using gone
    where k.paragraph_id = gone.id
  )
  update public.requirements r
  set paragraph_superseded_at = gone.superseded_at
  from gone
  where r.paragraph_id = gone.id;
$$;

-- As in 20261024270000, plus a purge on every version the import records: every import then
-- clears what the previous imports superseded, even one that splits nothing.
create or replace function public.record_regulation_version(
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
  previous_sha256 text;
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

  select sha256 into previous_sha256
  from public.regulation_versions
  where regulation_id = reg and version_label = p_version_label;

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
        extracted_at = case when v.sha256 = excluded.sha256 then v.extracted_at end,
        extracted_with = case when v.sha256 = excluded.sha256 then v.extracted_with end,
        extraction_error = case when v.sha256 = excluded.sha256 then v.extraction_error end,
        paragraph_count = case when v.sha256 = excluded.sha256 then v.paragraph_count end
  returning id into ver;

  if previous_sha256 is not null and previous_sha256 <> p_sha256 then
    perform private.supersede_regulation_paragraphs(ver);
  end if;
  perform private.purge_superseded_regulation_paragraphs(p_organization_id);
  return ver;
end;
$$;

-- As in 20261024270000, plus: a requirement moved to a current row is no longer flagged.
create or replace function private.relink_requirements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.requirements r
  set paragraph_id = n.id,
      paragraph_superseded_at = null
  from inserted n
  where r.version_id = n.version_id
    and r.paragraph_hash = n.content_hash
    and r.paragraph is not distinct from n.label
    and (r.paragraph_id is null
         or exists (select 1 from public.regulation_paragraphs o
                    where o.id = r.paragraph_id and o.superseded_at is not null));
  return null;
end;
$$;
