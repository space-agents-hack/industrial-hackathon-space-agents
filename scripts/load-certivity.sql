-- Replace Certivity's reference files in public.certivity_reference with the rows in the file
-- :rows_file (a JSON array from `python -m agent_service.domain.load_certivity --json <package>`).
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v rows_file=rows.json -f scripts/load-certivity.sql
--
-- The file is read here, not passed with -v rows=...: the files are about 190 kB together, and
-- Linux refuses a single command-line argument over 128 kB.
--
-- Used by the release workflow, which holds the database password but not the API's secret key.
-- One transaction: a check reads either the old files or the new ones, never a mix or nothing.
-- A file the new package no longer has is deleted, as `make certivity-load` does.

\set rows `cat :'rows_file'`

begin;

create temp table incoming on commit drop as
select kind, case_id, content, certivity_commit
from jsonb_to_recordset(:'rows'::jsonb)
  as r(kind text, case_id text, content jsonb, certivity_commit text);

insert into public.certivity_reference (kind, case_id, content, certivity_commit)
select kind, case_id, content, certivity_commit from incoming
on conflict (kind, case_id) do update
  set content = excluded.content,
      certivity_commit = excluded.certivity_commit,
      loaded_at = now();

delete from public.certivity_reference t
where not exists (select 1 from incoming i where i.kind = t.kind and i.case_id = t.case_id);

select kind, case_id, certivity_commit from public.certivity_reference order by kind, case_id;

commit;
