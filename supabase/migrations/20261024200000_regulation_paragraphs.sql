-- The paragraphs of each stored regulation version, with the pages they are on, and full-text
-- search over them (docs/regulations-store.md, #3, IF-3).
--
-- Filled by the agent after an import has stored the PDFs (agent/agent_service/domain/paragraphs.py
-- splits a PDF; regulations.py runs it for every version that has no paragraphs yet). A submission
-- cites regulation, version, page and paragraph; a row here answers all four: the version's
-- regulation and label, `label` for the paragraph, and `page_start`..`page_end`, because the
-- platform scores the whole page range of a paragraph that spans pages.
--
-- Same reading rules as the rest of the library (20261024180000_regulations.sql): everyone in the
-- organisation reads, nobody but the agent writes.
--
-- Embeddings are not here. They go in their own table keyed by `content_hash` (the embeddings
-- work, a later migration): most paragraphs are identical in base and latest, and a key on the
-- text embeds each once and lets a second model sit beside the first.

-- Which extractor produced a version's paragraphs. The import extracts every version whose value
-- differs from the agent's current one, so improving the splitter re-extracts the library on the
-- next import instead of leaving paragraphs cut the old way. Set on failure too, with the error,
-- so a PDF that cannot be split is not retried on every import with the same extractor.
alter table public.regulation_versions
  add column extracted_with   text check (length(extracted_with) <= 50),
  add column extraction_error text check (length(extraction_error) <= 1000),
  add column paragraph_count  integer check (paragraph_count >= 0);

create table public.regulation_paragraphs (
  id               uuid primary key default gen_random_uuid(),
  version_id       uuid not null references public.regulation_versions (id) on delete cascade,
  -- The version's organisation, repeated so the read policy needs no join.
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- Document order, from 0.
  position         integer not null check (position >= 0),
  -- What a submission cites: "5.4.2.3", "Annex 4 Part 1 1.2". Null only for unnumbered text
  -- before the first heading of the document. Not unique: a few annexes repeat a form, and the
  -- extractor reports those as warnings rather than inventing labels.
  label            text check (length(label) <= 500),
  annex            text check (length(annex) <= 20),
  appendix         text check (length(appendix) <= 20),
  part             text check (length(part) <= 20),
  -- "5.4.2.3", without the dot the regulation prints after it.
  number           text check (length(number) <= 60),
  -- The titles above the paragraph ("Annex 6 Environmental Testing > Part 1 - Resistance to
  -- heat"). The words that say what "shall not exceed 30 cd" is about.
  heading          text not null default '' check (length(heading) <= 4000),
  kind             text not null check (kind in ('paragraph', 'text')),
  text             text not null,
  page_start       integer not null check (page_start > 0),
  page_end         integer not null,
  -- sha256 of `text`. Equal in two versions means the paragraph did not change (the sub-goal's
  -- diff), and one embedding serves every paragraph with the same text.
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- A generated line of context, if a pilot shows headings are not enough (docs, "The two AI
  -- fields"). Nothing writes it yet; it is here so the search below does not have to be rebuilt.
  context          text check (length(context) <= 2000),
  -- English stemming: the regulations are in English (docs: no other languages). The label weighs
  -- most, so "6.2.1" finds paragraph 6.2.1 before the paragraphs that cite it.
  fts              tsvector generated always as (
                     setweight(to_tsvector('english', coalesce(label, '')), 'A')
                     || setweight(to_tsvector('english', heading || ' ' || coalesce(context, '')), 'B')
                     || setweight(to_tsvector('english', text), 'C')
                   ) stored,
  created_at       timestamptz not null default now(),
  check (page_end >= page_start),
  unique (version_id, position)
);

create index regulation_paragraphs_fts_idx on public.regulation_paragraphs using gin (fts);
create index regulation_paragraphs_label_idx on public.regulation_paragraphs (version_id, label);
create index regulation_paragraphs_hash_idx on public.regulation_paragraphs (content_hash);
create index regulation_paragraphs_org_idx on public.regulation_paragraphs (organization_id);

alter table public.regulation_paragraphs enable row level security;

revoke all on public.regulation_paragraphs from anon, authenticated;
grant select on public.regulation_paragraphs to authenticated;
grant all on public.regulation_paragraphs to service_role;

create policy "people read their organisation's regulation paragraphs"
on public.regulation_paragraphs for select to authenticated
using (private.can_read(organization_id));

-- ------------------------------------------------------------------------------------------
-- Functions
-- ------------------------------------------------------------------------------------------

-- The agent replaces a version's paragraphs in one transaction, so nobody ever reads half of the
-- old set and half of the new. `p_sha256` is the file the agent split: if an import stored another
-- file under this version meanwhile, nothing is written and the result is null; the next import
-- extracts the new file.
create function public.replace_regulation_paragraphs(
  p_version_id     uuid,
  p_sha256         text,
  p_extracted_with text,
  p_page_count     integer,
  p_paragraphs     jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  written integer;
begin
  select organization_id into org
  from public.regulation_versions
  where id = p_version_id and sha256 = p_sha256
  for update;
  if org is null then
    return null;
  end if;

  delete from public.regulation_paragraphs where version_id = p_version_id;
  insert into public.regulation_paragraphs (version_id, organization_id, position, label, annex,
    appendix, part, number, heading, kind, text, page_start, page_end, content_hash)
  select p_version_id, org, p.position, p.label, p.annex, p.appendix, p.part, p.number,
    coalesce(p.heading, ''), p.kind, p.text, p.page_start, p.page_end, p.content_hash
  from jsonb_to_recordset(p_paragraphs) as p(position integer, label text, annex text,
    appendix text, part text, number text, heading text, kind text, text text, page_start integer,
    page_end integer, content_hash text);
  get diagnostics written = row_count;

  update public.regulation_versions
  set page_count = p_page_count,
      extracted_at = now(),
      extracted_with = p_extracted_with,
      extraction_error = null,
      paragraph_count = written
  where id = p_version_id;
  return written;
end;
$$;

-- The agent could not split this file. Its paragraphs (from an older extractor, if any) go: the
-- library shows the error instead of paragraphs that no longer match how the rest were cut.
create function public.record_regulation_extraction_failure(
  p_version_id     uuid,
  p_sha256         text,
  p_extracted_with text,
  p_error          text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.regulation_versions
  set extracted_at = now(),
      extracted_with = p_extracted_with,
      extraction_error = left(p_error, 1000),
      paragraph_count = null
  where id = p_version_id and sha256 = p_sha256;
  if found then
    delete from public.regulation_paragraphs where version_id = p_version_id;
  end if;
end;
$$;

-- As in 20261024180000_regulations.sql, plus: a different file under the same version also drops
-- its paragraphs and the extraction columns, so the next import extracts the new file. Without
-- this the old paragraphs would stay, citing pages of a PDF that is no longer in the bucket.
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
    delete from public.regulation_paragraphs where version_id = ver;
  end if;
  return ver;
end;
$$;

revoke all on function
  public.replace_regulation_paragraphs(uuid, text, text, integer, jsonb),
  public.record_regulation_extraction_failure(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.replace_regulation_paragraphs(uuid, text, text, integer, jsonb),
  public.record_regulation_extraction_failure(uuid, text, text, text)
  to service_role;
