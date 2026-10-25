-- What a demo organisation would be copied from (#59): names, counts and sizes, nothing else.
-- Reads only. Run by .github/workflows/demo-org.yml before a copy, so the copy is chosen from
-- what production holds, not from a guess.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v source=team-09 -v case_like=%rear-lamp% \
--     -v project=dev-rear-lamp -v main_runs=2 -v review_runs=2 -f scripts/demo-org-inventory.sql
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

-- A copy roughly doubles the library's rows and files. On a plan with a size limit (Supabase Free:
-- 500 MB of database, 1 GB of files) going over it makes the database read-only for everyone, so
-- the copy is decided with these numbers next to the plan's limits.
\echo '== Database size, and the largest tables'
select pg_size_pretty(pg_database_size(current_database())) as database;
select c.relname as table_name, pg_size_pretty(pg_total_relation_size(c.oid)) as total
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 8;

\echo '== Share of the source in the library tables'
select 'regulation_paragraphs' as table_name,
       pg_size_pretty(sum(pg_column_size(p.*))::bigint) as source_rows
from public.regulation_paragraphs p join public.organizations o on o.id = p.organization_id
where o.name = :'source'
union all
select 'regulation_embeddings', pg_size_pretty(sum(pg_column_size(e.*))::bigint)
from public.regulation_embeddings e join public.organizations o on o.id = e.organization_id
where o.name = :'source';

\echo '== Storage, every organisation'
select s.bucket_id, count(*) as objects,
       pg_size_pretty(sum(coalesce((s.metadata ->> 'size')::bigint, 0))) as size
from storage.objects s
group by s.bucket_id;

-- What a copy of the project's latest runs would need from the library, to size a smaller copy:
-- the regulations its requirements cite or its sub-goal cases compare, and their paragraphs.
-- `on_disk` scales the rows' own size by the table's indexes and TOAST, as measured above.
\echo '== Paragraphs a copy of the latest runs needs (main_runs and review_runs from the copy step)'
with project as (
  select p.id from public.projects p join public.organizations o on o.id = p.organization_id
  where o.name = :'source' and p.name = :'project'
), chosen as (
  select r.id from (
    select r.id, c.kind, row_number() over (partition by c.kind order by r.created_at desc) as nth
    from public.runs r join public.cases c on c.id = r.case_id
    where c.project_id in (select id from project) and r.status = 'succeeded'
  ) r
  where (r.kind = 'main' and r.nth <= :main_runs) or (r.kind = 'subgoal' and r.nth <= :review_runs)
), cited_versions as (
  select q.version_id as id from public.requirements q where q.run_id in (select id from chosen)
  union
  select unnest(array[c.old_version_id, c.new_version_id]) from public.cases c
  where c.project_id in (select id from project)
), cited_regulations as (
  select distinct v.regulation_id as id from public.regulation_versions v
  where v.id in (select id from cited_versions)
), factor as (
  select pg_total_relation_size('public.regulation_paragraphs')::numeric
         / greatest(sum(pg_column_size(p.*)), 1) as k
  from public.regulation_paragraphs p
)
select 'every paragraph' as scope, count(*) as paragraphs,
       pg_size_pretty((sum(pg_column_size(p.*)) * (select k from factor))::bigint) as on_disk
from public.regulation_paragraphs p join public.organizations o on o.id = p.organization_id
where o.name = :'source'
union all
select 'current paragraphs', count(*), pg_size_pretty((sum(pg_column_size(p.*)) * (select k from factor))::bigint)
from public.regulation_paragraphs p join public.organizations o on o.id = p.organization_id
where o.name = :'source' and p.superseded_at is null
union all
select 'current, of the ' || (select count(*) from cited_regulations) || ' cited regulations', count(*),
       pg_size_pretty((sum(pg_column_size(p.*)) * (select k from factor))::bigint)
from public.regulation_paragraphs p join public.regulation_versions v on v.id = p.version_id
where v.regulation_id in (select id from cited_regulations) and p.superseded_at is null
union all
select 'cited by the requirements only', count(*), pg_size_pretty((sum(pg_column_size(p.*)) * (select k from factor))::bigint)
from public.regulation_paragraphs p
where p.id in (select q.paragraph_id from public.requirements q where q.run_id in (select id from chosen));
