-- The pictures of the regulation PDFs and what a vision model read in them (#52; SYS-23, SYS-33,
-- IF-3, IF-7).
--
-- Why: 2,569 of the 2,572 pictures of at least 40 pt in the challenge's 92 PDFs have no text
-- layer, and in 8 picked at random 6 carried values a requirement needs (dimensions, set-ups,
-- charts). The import now has a vision model describe each picture once per organisation
-- (agent domain/figures.py) and writes the description into the paragraph the picture sits in.
-- These tables keep the descriptions, so a picture is not described twice, and say where each
-- picture is, so the Regulations page can list a version's figures with the model that read them.
--
-- Additive: the running agent never reads or writes these, and the widened checks keep every
-- existing row valid, so the order of release does not matter.
--
-- What this does NOT hold: the pictures themselves. They are rendered again from the stored PDF.
--
-- Deleting a regulation (delete_regulations) removes its versions' figures with them but keeps the
-- descriptions, as it keeps regulation_embeddings: a cache by content, so importing the same PDFs
-- again costs no vision call. They go with the organisation.

-- ------------------------------------------------------------------------------------------
-- The process an admin chooses a model for, and the usage it records
-- ------------------------------------------------------------------------------------------

alter table public.organization_models drop constraint organization_models_process_check;
alter table public.organization_models add constraint organization_models_process_check
  check (process in ('check', 'transcription', 'summary', 'embedding', 'chat', 'figures'));

alter table public.model_usage drop constraint model_usage_process_check;
alter table public.model_usage add constraint model_usage_process_check
  check (process in ('writer', 'check', 'transcription', 'summary', 'embedding', 'search', 'chat',
                     'figures'));

-- ------------------------------------------------------------------------------------------
-- Descriptions, one per picture per organisation
-- ------------------------------------------------------------------------------------------

-- Keyed by the sha256 of the picture's image stream, not by version: the same picture in a base
-- and a latest version, or an approval mark in many regulations, is described once. Per
-- organisation, because the model, the key and the bill are the organisation's (SYS-16).
create table public.regulation_figure_descriptions (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  image_sha256     text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  -- Null when the provider refused this picture; `error` then says why, and it is not sent again.
  description      text check (length(description) <= 3000),
  -- "provider:model" as chosen in Admin (organization_models 'figures') or FIGURE_MODEL.
  model            text not null check (length(model) between 1 and 200),
  error            text check (length(error) <= 1000),
  described_at     timestamptz not null default now(),
  primary key (organization_id, image_sha256),
  check (description is not null or error is not null)
);

alter table public.regulation_figure_descriptions enable row level security;

-- Only the agent writes, with the secret key. Members read them on the Regulations page.
revoke all on public.regulation_figure_descriptions from anon, authenticated;
grant select on public.regulation_figure_descriptions to authenticated;
grant all on public.regulation_figure_descriptions to service_role;

create policy "people read their organisation's figure descriptions"
on public.regulation_figure_descriptions for select to authenticated
using (private.can_read(organization_id));

-- ------------------------------------------------------------------------------------------
-- Where each picture is
-- ------------------------------------------------------------------------------------------

create table public.regulation_figures (
  version_id       uuid not null references public.regulation_versions (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  page             integer not null check (page >= 1),
  -- Among the page's pictures, in drawing order.
  position         integer not null check (position >= 0),
  image_sha256     text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  width_pt         real not null check (width_pt > 0),
  height_pt        real not null check (height_pt > 0),
  primary key (version_id, page, position)
);

create index regulation_figures_lookup_idx
  on public.regulation_figures (organization_id, image_sha256);

alter table public.regulation_figures enable row level security;

revoke all on public.regulation_figures from anon, authenticated;
grant select on public.regulation_figures to authenticated;
grant all on public.regulation_figures to service_role;

create policy "people read their organisation's figures"
on public.regulation_figures for select to authenticated
using (private.can_read(organization_id));

-- Distinct pictures of the version that had neither a description nor a recorded error when it
-- was last split. More than 0 lists the version for the next import (agent library_store.py
-- versions_to_split), which splits it again once more of them are described.
alter table public.regulation_versions add column figures_missing integer not null default 0
  check (figures_missing >= 0);

-- The agent replaces a version's pictures after saving its paragraphs. `p_sha256` is the file it
-- split, as in replace_regulation_paragraphs: if another file was stored under this version
-- meanwhile, nothing is written.
create function public.replace_regulation_figures(
  p_version_id uuid,
  p_sha256     text,
  p_missing    integer,
  p_figures    jsonb
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

  delete from public.regulation_figures where version_id = p_version_id;
  insert into public.regulation_figures (version_id, organization_id, page, position, image_sha256,
    width_pt, height_pt)
  select p_version_id, org, f.page, f.position, f.image_sha256, f.width_pt, f.height_pt
  from jsonb_to_recordset(p_figures) as f(page integer, position integer, image_sha256 text,
    width_pt real, height_pt real);
  get diagnostics written = row_count;

  update public.regulation_versions
  set figures_missing = greatest(p_missing, 0)
  where id = p_version_id;
  return written;
end;
$$;

revoke all on function public.replace_regulation_figures(uuid, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_regulation_figures(uuid, text, integer, jsonb)
  to service_role;
