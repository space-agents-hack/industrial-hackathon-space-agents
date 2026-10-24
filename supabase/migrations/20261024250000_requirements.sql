-- The requirements a run writes for a case, each linked to one regulation paragraph (ADR-0006;
-- docs/se SYS-25, SYS-29; IF-4; issue #4). The Certivity submission is assembled from these rows,
-- so what a person reviews in the app and what is uploaded are the same thing.
--
-- Who writes what: only the agent (secret key). It inserts a run's requirements as `draft`, the
-- check marks the ones it rejects, and a person's approval of the run's export marks the rest
-- `approved`. Everyone in the organisation reads them, as for cases.
--
-- The citation (regulation, version_label, page, paragraph) is copied by code from the paragraph
-- row, never typed by the model, so a requirement cannot cite a paragraph that does not exist
-- (SYS-5, SYS-6). It is kept on the row, not only reached through `paragraph_id`, because:
--
-- `paragraph_id` is nullable and set to null when the paragraph goes. ADR-0006 says "not null";
-- that does not survive the library as built: replace_regulation_paragraphs()
-- (20261024200000) deletes and reinserts a version's paragraphs on every re-extraction, with new
-- ids. With `not null` a re-extraction would either fail (restrict) once any requirement exists,
-- or delete every requirement of that version (cascade). Instead the link is cleared and restored
-- by the trigger at the end of this file when the same text comes back under the same label. A
-- link that stays null means the paragraph's text changed: that is the sub-goal's signal (SYS-19),
-- and the requirement still says what it cited.

create table public.requirements (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null,
  organization_id  uuid not null,
  -- The run that wrote it. A case is run many times (one per prompt or model); each run's set is
  -- kept whole so two runs can be compared.
  run_id           uuid not null references public.runs (id) on delete cascade,
  -- Certivity's id format for submitted requirements ("R-001"), given in submission order.
  ext_id           text not null check (ext_id ~ '^R-[0-9]{3,}$'),
  -- Certivity's schema allows 2000 characters.
  text             text not null check (length(btrim(text)) between 1 and 2000),
  test_case        text check (test_case is null or length(test_case) <= 4000),
  version_id       uuid references public.regulation_versions (id) on delete set null,
  paragraph_id     uuid references public.regulation_paragraphs (id) on delete set null,
  -- The cited paragraph's content_hash when the requirement was written: how the link is found
  -- again after a re-extraction, and how the sub-goal tells a changed paragraph from a moved one.
  paragraph_hash   text not null check (paragraph_hash ~ '^[0-9a-f]{64}$'),
  -- What the submission cites, exactly as the library holds it.
  regulation       text not null check (length(regulation) between 1 and 200),
  version_label    text not null check (length(version_label) between 1 and 200),
  page             integer not null check (page >= 1),
  -- Null for text before the first numbered heading, which has no label to cite.
  paragraph        text check (paragraph is null or length(paragraph) <= 500),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  -- What the check found ({"by": "check-agent", "problem": "...", "action": "..."}). Rejected
  -- rows keep their findings, so a person sees what was dropped and why.
  findings         jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (run_id, ext_id),
  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade
);

create index requirements_case_idx on public.requirements (case_id, created_at desc);
-- Without it every paragraph deleted by a re-extraction scans this table to clear its links.
create index requirements_paragraph_idx on public.requirements (paragraph_id)
  where paragraph_id is not null;
create index requirements_relink_idx on public.requirements (version_id, paragraph_hash)
  where paragraph_id is null;

create trigger requirements_set_updated_at
before update on public.requirements
for each row execute function public.set_updated_at();

alter table public.requirements enable row level security;

revoke all on public.requirements from anon, authenticated;
grant select on public.requirements to authenticated;
grant all on public.requirements to service_role;

create policy "people read their organisation's requirements"
on public.requirements for select to authenticated
using (private.can_read(organization_id));

-- ------------------------------------------------------------------------------------------
-- Links restored after a re-extraction
-- ------------------------------------------------------------------------------------------

-- replace_regulation_paragraphs() deletes a version's paragraphs (clearing `paragraph_id` above)
-- and inserts the new ones in one statement. This puts each link back on the new row with the
-- same text and label. Two rows with the same label and text in one version (a repeated form in
-- an annex) are the same citation, so either is right.
create function private.relink_requirements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.requirements r
  set paragraph_id = n.id
  from inserted n
  where r.paragraph_id is null
    and r.version_id = n.version_id
    and r.paragraph_hash = n.content_hash
    and r.paragraph is not distinct from n.label;
  return null;
end;
$$;

revoke all on function private.relink_requirements() from public, anon, authenticated;

create trigger regulation_paragraphs_relink_requirements
after insert on public.regulation_paragraphs
referencing new table as inserted
for each statement execute function private.relink_requirements();
