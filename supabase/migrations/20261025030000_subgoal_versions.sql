-- A sub-goal case reads both versions from its organisation's regulation library (#42, SYS-45;
-- Clemente, 2026-10-25: "processed and properly done in the DB"; Ramón's OK on #52, 01:33 UTC).
--
-- The run finds each of the case's two PDFs in the library by its sha256, an exact file match and
-- not a guess by name. A PDF the library does not have is put through the library's own ingestion
-- (stored, recorded with no role, split with the current extractor and its figures), so both goals
-- read one extraction.
--
-- Additive: the running code never reads these columns, and every existing case keeps null.

-- The lookup by file. The table is small today (about 100 versions per organisation); the index is
-- for a library that grows, and for the case of two runs looking up at once.
create index regulation_versions_sha256_idx
  on public.regulation_versions (organization_id, sha256);

-- Which library versions a sub-goal case compared, written by the agent at its last run. Without
-- it the run's trace is the only record, and the case page cannot say what it compared.
--
-- The pair (id, organization_id) is the foreign key so a case can only point at a version of its
-- own organisation, as runs point at cases. `on delete set null` on the version column alone: an
-- admin who clears a regulation from the library (delete_regulations, #56) keeps the case, its
-- files and its runs; only the link goes.
alter table public.regulation_versions
  add constraint regulation_versions_id_organization_key unique (id, organization_id);

alter table public.cases
  add column old_version_id uuid,
  add column new_version_id uuid,
  add constraint cases_old_version_fkey foreign key (old_version_id, organization_id)
    references public.regulation_versions (id, organization_id) on delete set null (old_version_id),
  add constraint cases_new_version_fkey foreign key (new_version_id, organization_id)
    references public.regulation_versions (id, organization_id) on delete set null (new_version_id);

-- No grant to authenticated: members read the columns with the rest of the case (the table's
-- select grant), and only the agent writes them, with the secret key.
