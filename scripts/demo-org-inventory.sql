-- What a demo organisation would be copied from (#59): names, counts and sizes, nothing else.
-- Reads only. Run by .github/workflows/demo-org.yml before a copy, so the copy is chosen from
-- what production holds, not from a guess.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v source=team-09 -v case_like=%rear-lamp% \
--     -f scripts/demo-org-inventory.sql
--
-- No paragraph text, case content or requirement text is printed: the output lands in a CI log.

\pset footer off

\echo '== Organisations'
select o.id, o.name, o.created_at::date,
       (select count(*) from public.memberships m where m.organization_id = o.id) as members
from public.organizations o
order by o.created_at;

\echo '== Regulation library of the source'
select count(distinct r.id) as regulations,
       count(distinct v.id) as versions,
       (select count(*) from public.regulation_paragraphs p
        join public.organizations o on o.id = p.organization_id
        where o.name = :'source') as paragraphs,
       (select count(*) from public.regulation_paragraph_keys k
        join public.organizations o on o.id = k.organization_id
        where o.name = :'source') as paragraph_keys,
       (select count(*) from public.regulation_figures f
        join public.organizations o on o.id = f.organization_id
        where o.name = :'source') as figures,
       (select count(*) from public.regulation_figure_descriptions d
        join public.organizations o on o.id = d.organization_id
        where o.name = :'source') as figure_descriptions,
       count(*) filter (where v.scope_summary is not null) as summarised_versions
from public.regulations r
join public.organizations o on o.id = r.organization_id
left join public.regulation_versions v on v.regulation_id = r.id
where o.name = :'source';

\echo '== Embeddings of the source, by model'
select e.model, count(*) as vectors
from public.regulation_embeddings e
join public.organizations o on o.id = e.organization_id
where o.name = :'source'
group by e.model;

\echo '== Storage of the source, by bucket'
select s.bucket_id, count(*) as objects,
       pg_size_pretty(sum(coalesce((s.metadata ->> 'size')::bigint, 0))) as size
from storage.objects s
join public.organizations o on o.id::text = split_part(s.name, '/', 1)
where o.name = :'source'
group by s.bucket_id;

\echo '== Projects and cases of the source'
select p.id as project_id, p.name as project, p.all_regulations,
       c.id as case_id, c.name as case_name, c.kind, c.created_at,
       (select count(*) from public.case_files f where f.case_id = c.id) as files,
       (select count(*) from public.runs r where r.case_id = c.id) as runs
from public.projects p
join public.organizations o on o.id = p.organization_id
left join public.cases c on c.project_id = p.id
where o.name = :'source'
order by p.created_at, c.created_at;

\echo '== Runs on cases named like the pattern, and on every sub-goal case, newest first'
select r.id, c.name as case_name, c.kind, r.status, r.created_at, r.model,
       r.output is not null as has_output,
       (select count(*) from public.requirements q where q.run_id = r.id) as requirements,
       (select count(*) from public.run_events e where e.run_id = r.id) as events,
       (select count(*) from public.run_checks k where k.run_id = r.id) as checks,
       (select count(*) from public.run_files f where f.run_id = r.id) as run_files,
       left(r.task, 60) as task
from public.runs r
join public.cases c on c.id = r.case_id
join public.organizations o on o.id = r.organization_id
where o.name = :'source' and (c.kind = 'subgoal' or c.name ilike :'case_like'
  or exists (select 1 from public.projects p where p.id = c.project_id and p.name ilike :'case_like'))
order by r.created_at desc
limit 40;

\echo '== Files of those cases'
select c.name as case_name, c.kind, f.position, f.filename, f.format, f.bytes, f.status,
       (select count(*) from public.case_file_blocks b where b.file_id = f.id) as blocks,
       (select count(*) from public.case_file_blocks b where b.file_id = f.id and b.image_path is not null) as block_images
from public.case_files f
join public.cases c on c.id = f.case_id
join public.organizations o on o.id = f.organization_id
where o.name = :'source' and (c.kind = 'subgoal' or c.name ilike :'case_like'
  or exists (select 1 from public.projects p where p.id = c.project_id and p.name ilike :'case_like'))
order by c.created_at, f.position;

\echo '== Auth: does the demo address exist already'
select count(*) as accounts_with_that_email from auth.users where email = lower(:'email');
