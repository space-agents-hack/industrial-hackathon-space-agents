-- What the web needs to let people manage their own projects, cases and regulations (docs/se
-- SYS-31, SYS-32, SYS-33; issues #23, #24, #25; design/ux-hierarchy.md in the project files).
--
-- 1. Members rename projects and cases, delete them, and remove a file from a case (SYS-31).
--    Until now an uploaded case was kept as evidence and only the agent's key could delete it
--    (20261024160000). Clemente, 2026-10-24: members may delete, "this is a demo". A run keeps its
--    record when its case goes (runs.case_id is set null), but loses the files it read.
-- 2. A project chooses which regulations of its organisation's library it uses (SYS-32). The
--    library itself stays per organisation, as Ramón built it; nothing in his tables changes.
-- 3. An organisation picks the model of each agent and process (SYS-33).
--
-- Additive only: the running agent and web keep working before their new code is deployed.

-- ------------------------------------------------------------------------------------------
-- 1. Rename and delete
-- ------------------------------------------------------------------------------------------

grant update (name) on public.projects, public.cases to authenticated;
grant delete on public.projects, public.cases, public.case_files to authenticated;

-- Same roles as creating. A viewer reads only.
create policy "members rename their organisation's projects"
on public.projects for update to authenticated
using (private.has_role(organization_id, array['admin', 'member']))
with check (private.has_role(organization_id, array['admin', 'member']));

create policy "members delete their organisation's projects"
on public.projects for delete to authenticated
using (private.has_role(organization_id, array['admin', 'member']));

create policy "members rename their organisation's cases"
on public.cases for update to authenticated
using (private.has_role(organization_id, array['admin', 'member']))
with check (private.has_role(organization_id, array['admin', 'member']));

create policy "members delete their organisation's cases"
on public.cases for delete to authenticated
using (private.has_role(organization_id, array['admin', 'member']));

create policy "members remove files from their organisation's cases"
on public.case_files for delete to authenticated
using (private.has_role(organization_id, array['admin', 'member']));

-- Rows do not take their Storage objects with them, so the web removes the objects (the upload
-- and the pages the agent rendered under {org}/{case}/blocks/) after the row. If that fails the
-- bytes stay behind, unreachable from the app; scripts/purge-challenge-data.sh empties the bucket.
create policy "members delete their organisation's case files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'case-files'
  and private.has_role(private.path_organization(name), array['admin', 'member'])
);

-- ------------------------------------------------------------------------------------------
-- 2. A project's regulations
-- ------------------------------------------------------------------------------------------

-- true: every regulation in the organisation's library, including the ones imported later. That
-- is the default because the held-out case may bring new PDFs, and a project created before they
-- arrive must still see them. false: exactly the rows in project_regulations.
--
-- Why "all" is the safe default: F2 counts a missed requirement four times as heavily as an extra
-- one, and the writer cannot find a requirement in a regulation the project left out.
alter table public.projects add column all_regulations boolean not null default true;
grant update (all_regulations) on public.projects to authenticated;

create table public.project_regulations (
  project_id       uuid not null,
  regulation_id    uuid not null references public.regulations (id) on delete cascade,
  -- The project's organisation, repeated so the policies read one column.
  organization_id  uuid not null,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  primary key (project_id, regulation_id),
  foreign key (project_id, organization_id)
    references public.projects (id, organization_id) on delete cascade
);

create index project_regulations_regulation_idx on public.project_regulations (regulation_id);

alter table public.project_regulations enable row level security;
revoke all on public.project_regulations from anon, authenticated;
grant select, delete on public.project_regulations to authenticated;
grant insert (project_id, regulation_id, organization_id) on public.project_regulations to authenticated;
grant all on public.project_regulations to service_role;

create policy "people read their organisation's project regulations"
on public.project_regulations for select to authenticated
using (private.can_read(organization_id));

-- The regulation must be in the same organisation's library. Checked here rather than with a
-- composite key, which would need a new unique constraint on Ramón's `regulations` table.
create policy "members choose regulations for their organisation's projects"
on public.project_regulations for insert to authenticated
with check (
  private.has_role(organization_id, array['admin', 'member'])
  and created_by = (select auth.uid())
  and exists (
    select 1 from public.regulations r
    where r.id = regulation_id and r.organization_id = project_regulations.organization_id
  )
);

create policy "members drop regulations from their organisation's projects"
on public.project_regulations for delete to authenticated
using (private.has_role(organization_id, array['admin', 'member']));

-- ------------------------------------------------------------------------------------------
-- 3. A model per agent and process
-- ------------------------------------------------------------------------------------------

-- The writer's model stays where it is: organization_settings.model, which the running agent
-- already reads. Storing it here as well would make two places for one setting, and they would
-- drift apart without anyone seeing it. This table holds the other processes. A missing row means
-- the deployment's default (agent/agent_service/settings.py).
comment on column public.organization_settings.model is
  'The requirement writer''s model (the run agent). The other processes are in organization_models.';

create table public.organization_models (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- check:          the check agent (SYS-29)
  -- transcription:  what reads the case pages a parser cannot (INGEST_MODEL)
  -- summary:        the scope summary of each regulation version (SUMMARY_MODEL)
  -- embedding:      the regulation vectors (EMBEDDING_MODEL). Vectors are kept per model
  --                 (regulation_embeddings.model), so a change keeps the old ones, but the
  --                 library has to be indexed again before vector search uses the new model.
  process          text not null check (process in ('check', 'transcription', 'summary', 'embedding')),
  -- "provider:model", as organization_settings.model.
  model            text not null check (length(model) between 1 and 200 and position(':' in model) > 1),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  primary key (organization_id, process)
);

alter table public.organization_models enable row level security;
revoke all on public.organization_models from anon, authenticated;
grant select on public.organization_models to authenticated;
grant all on public.organization_models to service_role;

create policy "people read their organisation's models"
on public.organization_models for select to authenticated
using (private.can_read(organization_id));

-- Admins only, as for the writer's model, and audited the same way. An empty model goes back to
-- the deployment's default.
create function public.set_organization_model(org uuid, model_process text, new_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_manage(org) then
    raise exception 'only an admin of this organisation changes its models' using errcode = '42501';
  end if;
  -- The embeddings endpoint the agent knows is OpenAI's API, directly or through OpenRouter
  -- (domain/regulation_search.py, docs/regulations-store.md). Anything else would only fail at
  -- the next index, so it is refused here, where the admin sees why.
  if model_process = 'embedding' and nullif(btrim(new_model), '') is not null
     and split_part(btrim(new_model), ':', 1) not in ('openai', 'openrouter') then
    raise exception 'an embedding model is openai:<model> or openrouter:<model>' using errcode = '22023';
  end if;
  if nullif(btrim(new_model), '') is null then
    delete from public.organization_models where organization_id = org and process = model_process;
  else
    insert into public.organization_models (organization_id, process, model, updated_at, updated_by)
    values (org, model_process, btrim(new_model), now(), (select auth.uid()))
    on conflict (organization_id, process) do update set
      model = excluded.model, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  perform private.audit(org, 'model.set', jsonb_build_object(
    'process', model_process, 'model', nullif(btrim(new_model), '')));
end;
$$;

revoke all on function public.set_organization_model(uuid, text, text) from public, anon;
grant execute on function public.set_organization_model(uuid, text, text) to authenticated;

-- A member may ask for another writer model for one run (comparing Sonnet and Opus on the same
-- case). The agent records the model it actually used in runs.model, as before; an agent that does
-- not know this column yet ignores it and uses the organisation's model.
alter table public.runs add column requested_model text
  check (requested_model is null or (length(requested_model) between 1 and 200 and position(':' in requested_model) > 1));
grant insert (requested_model) on public.runs to authenticated;
