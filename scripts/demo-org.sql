-- A read-only demo organisation (#59, SYS-47): a copy of one organisation's regulation library,
-- one of its projects with its cases and files, and that project's latest runs, plus an account
-- that can only look at it.
--
--   DEMO_PASSWORD=... psql "$DB_URL" -v ON_ERROR_STOP=1 -v source=team-09 -v target=certivity \
--     -v project=dev-rear-lamp -v main_runs=2 -v review_runs=2 -v email=demo@certivity.demo \
--     [-v paragraphs=cited_regulations] [-v vectors=0] [-v replace=1] -f scripts/demo-org.sql
--
-- Copy, never move: the source is only read. Every id is new, and every id the copied rows carry
-- (in columns, in Storage paths, inside traces and notes) is mapped to its copy, so nothing in the
-- demo points back into the source, where its people could not follow it anyway.
--
-- What is copied, and why:
--   - every regulation and version, with its PDF, scope summary and figures with descriptions;
--   - their paragraphs, as `paragraphs` says: `all` (superseded ones too), `current`,
--     `cited_regulations` (the current paragraphs of every regulation the copied runs cite or
--     compare) or `cited` (only the paragraphs the copied requirements cite). Whatever the choice,
--     the cited ones are always in, superseded or not, so every copied requirement keeps its link.
--     Not always `all`, because of size: on 2026-10-25 production's database held 401 MB on a
--     plan whose limit is 500 MB (docs/regulations-store.md), and every paragraph of team-09 came
--     to about 100 MB on disk with its indexes, its vectors about as much again. A database over
--     its limit becomes read-only for everyone. `cited_regulations` was about 10 MB;
--   - search keys and vectors only with `vectors=1`: a read-only organisation never searches by
--     meaning, since the question itself would have to be embedded, a model call. Word search over
--     the paragraphs needs no vector;
--   - the project, all its cases (the main case and its sub-goal case) and their parsed files;
--   - the latest `main_runs` succeeded runs on the main cases and `review_runs` on the sub-goal
--     cases, with their trace, requirements, approvals and stored checks.
-- What is not: imports (their index holds signed download links), provider keys and endpoints,
-- model choices, settings, usage (the demo spent nothing) and saved conversations (`run_state`,
-- needed only to resume a run that is waiting, and these have finished).
--
-- Files: SQL cannot copy a file in Storage. Each one goes into public.storage_copies and the agent
-- copies it (POST /admin/storage-copies/advance); the workflow calls it until none is left.
--
-- The account: created here, not through Supabase Auth's API, because Auth refuses a password
-- under its minimum length (6 by default) and the one asked for was shorter. Auth accepts a
-- sign-in with it and reports the password as weak. The password comes from the environment
-- (DEMO_PASSWORD), never from a command line or a file. Without it, an existing account keeps
-- its password, and a new one is not created.
--
-- `replace=1` deletes an existing target first, and only if it is read-only: a writable
-- organisation of that name is someone's work, and this refuses to touch it.

\set ON_ERROR_STOP on
\getenv demo_password DEMO_PASSWORD
\if :{?replace}
\else
  \set replace 0
\endif
\if :{?paragraphs}
\else
  \set paragraphs cited_regulations
\endif
\if :{?vectors}
\else
  \set vectors 0
\endif
\if :{?demo_password}
\else
  \set demo_password ''
\endif

begin;

-- The library is about 64,000 paragraphs and 30,000 vectors: more than a request's timeout.
set local statement_timeout = 0;

-- psql does not put its variables inside the dollar-quoted block below; settings of this
-- transaction carry them there. \gset keeps them, the password included, out of the output.
select set_config('demo.source', :'source', true) as s1,
       set_config('demo.target', :'target', true) as s2,
       set_config('demo.project', :'project', true) as s3,
       set_config('demo.main_runs', :'main_runs', true) as s4,
       set_config('demo.review_runs', :'review_runs', true) as s5,
       set_config('demo.email', lower(:'email'), true) as s6,
       set_config('demo.password', :'demo_password', true) as s7,
       set_config('demo.replace', :'replace', true) as s8,
       set_config('demo.paragraphs', :'paragraphs', true) as s9,
       set_config('demo.vectors', :'vectors', true) as s10 \gset ignored_

-- Every old id and its copy. Paths, traces and notes are rewritten through this one table.
create temp table id_map (old_id uuid primary key, new_id uuid not null unique) on commit drop;

create function pg_temp.mapped(old uuid) returns uuid language sql stable as $$
  select new_id from id_map where old_id = old;
$$;

-- Each uuid in the text that has a copy is replaced by it; any other text is left as it was.
create function pg_temp.remap(t text) returns text language plpgsql stable as $$
declare
  m text;
  n uuid;
begin
  if t is null then
    return null;
  end if;
  for m in
    select distinct x[1]
    from regexp_matches(t, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') x
  loop
    n := pg_temp.mapped(m::uuid);
    if n is not null then
      t := replace(t, m, n::text);
    end if;
  end loop;
  return t;
end;
$$;

create function pg_temp.remap_json(j jsonb) returns jsonb language sql stable as $$
  select pg_temp.remap(j::text)::jsonb;
$$;

-- A Storage path of the source becomes the same path in the target, every id segment mapped. A
-- path outside the source's folder would be a file of another organisation: stop.
create function pg_temp.remap_path(p text, source_org uuid) returns text language plpgsql stable as $$
begin
  if p is null then
    return null;
  end if;
  if split_part(p, '/', 1) <> source_org::text then
    raise exception 'path % is not in the source organisation''s folder', p;
  end if;
  return pg_temp.remap(p);
end;
$$;

do $$
declare
  src uuid;
  dst uuid;
  existing record;
  proj uuid;
  demo_user uuid;
  pw text := current_setting('demo.password');
  n integer;
begin
  select id into src from public.organizations where name = current_setting('demo.source');
  if src is null then
    raise exception 'no organisation named %', current_setting('demo.source');
  end if;
  if (select count(*) from public.organizations where name = current_setting('demo.source')) > 1 then
    raise exception 'several organisations are named %', current_setting('demo.source');
  end if;

  for existing in select id, read_only from public.organizations
                  where name = current_setting('demo.target') loop
    if current_setting('demo.replace') <> '1' then
      raise exception 'an organisation named % exists; pass -v replace=1 to rebuild it',
        current_setting('demo.target');
    end if;
    if not existing.read_only then
      raise exception 'the organisation named % is writable: not replacing it', current_setting('demo.target');
    end if;
    -- Its rows go with it (on delete cascade); its copied files stay in Storage and are
    -- overwritten by the next copy only if the same path comes back, which it does not (new ids).
    delete from public.organizations where id = existing.id;
  end loop;

  select id into proj from public.projects
  where organization_id = src and name = current_setting('demo.project');
  if proj is null then
    raise exception 'no project named % in %', current_setting('demo.project'), current_setting('demo.source');
  end if;

  -- ---------------------------------------------------------------- what the runs need
  -- The latest that succeeded: a failed run shows a failure, not the product.
  create temp table chosen_runs on commit drop as
  select r.id from (
    select r.id, c.kind, row_number() over (partition by c.kind order by r.created_at desc) as nth
    from public.runs r join public.cases c on c.id = r.case_id
    where c.project_id = proj and r.status = 'succeeded'
  ) r
  where (r.kind = 'main' and r.nth <= current_setting('demo.main_runs')::integer)
     or (r.kind = 'subgoal' and r.nth <= current_setting('demo.review_runs')::integer);

  -- What the copied runs point at in the library: the paragraphs their requirements cite, and
  -- the regulations those belong to or the sub-goal cases compare.
  create temp table cited_paragraphs on commit drop as
  select distinct q.paragraph_id as id from public.requirements q
  where q.run_id in (select id from chosen_runs) and q.paragraph_id is not null;
  create temp table cited_regulations on commit drop as
  select distinct v.regulation_id as id from public.regulation_versions v
  where v.id in (
    select q.version_id from public.requirements q where q.run_id in (select id from chosen_runs)
    union
    select unnest(array[c.old_version_id, c.new_version_id]) from public.cases c where c.project_id = proj);

  if current_setting('demo.paragraphs') not in ('all', 'current', 'cited_regulations', 'cited') then
    raise exception 'paragraphs must be all, current, cited_regulations or cited, not %',
      current_setting('demo.paragraphs');
  end if;
  create temp table copied_paragraphs on commit drop as
  select p.id from public.regulation_paragraphs p
  join public.regulation_versions v on v.id = p.version_id
  where p.organization_id = src
    and (p.id in (select id from cited_paragraphs)
         or current_setting('demo.paragraphs') = 'all'
         or (current_setting('demo.paragraphs') = 'current' and p.superseded_at is null)
         or (current_setting('demo.paragraphs') = 'cited_regulations' and p.superseded_at is null
             and v.regulation_id in (select id from cited_regulations)));

  insert into public.organizations (name, read_only) values (current_setting('demo.target'), true)
  returning id into dst;
  insert into id_map values (src, dst);

  -- ---------------------------------------------------------------- the library
  insert into id_map select id, gen_random_uuid() from public.regulations where organization_id = src;
  insert into public.regulations (id, organization_id, code, slug, kind, title, source_url, created_at, updated_at)
  select pg_temp.mapped(r.id), dst, r.code, r.slug, r.kind, r.title, r.source_url, r.created_at, r.updated_at
  from public.regulations r where r.organization_id = src;

  insert into id_map select id, gen_random_uuid() from public.regulation_versions where organization_id = src;
  insert into public.regulation_versions (
    id, regulation_id, organization_id, version_label, role, status, title, file_name, sha256,
    size_bytes, pdf_path, md_path, page_count, extracted_at, last_import_id, created_at, updated_at,
    extracted_with, extraction_error, paragraph_count, scope_summary, scope_keywords, summary_model,
    summary_sha256, summarized_at, figures_missing)
  select pg_temp.mapped(v.id), pg_temp.mapped(v.regulation_id), dst, v.version_label, v.role, v.status,
    v.title, v.file_name, v.sha256, v.size_bytes, pg_temp.remap_path(v.pdf_path, src),
    pg_temp.remap_path(v.md_path, src), v.page_count, v.extracted_at, null, v.created_at, v.updated_at,
    v.extracted_with, v.extraction_error, v.paragraph_count, v.scope_summary, v.scope_keywords,
    v.summary_model, v.summary_sha256, v.summarized_at, v.figures_missing
  from public.regulation_versions v where v.organization_id = src;

  insert into id_map select id, gen_random_uuid() from copied_paragraphs;
  insert into public.regulation_paragraphs (
    id, version_id, organization_id, position, label, annex, appendix, part, number, heading, kind,
    text, page_start, page_end, content_hash, context, created_at, superseded_at)
  select pg_temp.mapped(p.id), pg_temp.mapped(p.version_id), dst, p.position, p.label, p.annex,
    p.appendix, p.part, p.number, p.heading, p.kind, p.text, p.page_start, p.page_end,
    p.content_hash, p.context, p.created_at, p.superseded_at
  from public.regulation_paragraphs p where p.id in (select id from copied_paragraphs);

  -- The key is a hash of the regulation's and the paragraph's text, not of any id, so it and the
  -- vectors stored under it are valid as they are.
  if current_setting('demo.vectors') = '1' then
    insert into public.regulation_paragraph_keys (paragraph_id, organization_id, input_sha256)
    select pg_temp.mapped(k.paragraph_id), dst, k.input_sha256
    from public.regulation_paragraph_keys k where k.paragraph_id in (select id from copied_paragraphs);

    insert into public.regulation_embeddings (organization_id, model, input_sha256, embedding, created_at)
    select dst, e.model, e.input_sha256, e.embedding, e.created_at
    from public.regulation_embeddings e
    where e.organization_id = src
      and e.input_sha256 in (select k.input_sha256 from public.regulation_paragraph_keys k
                             where k.paragraph_id in (select id from copied_paragraphs));
  end if;

  insert into public.regulation_figure_descriptions (organization_id, image_sha256, description, model, error, described_at)
  select dst, d.image_sha256, d.description, d.model, d.error, d.described_at
  from public.regulation_figure_descriptions d where d.organization_id = src;

  insert into public.regulation_figures (version_id, organization_id, page, position, image_sha256, width_pt, height_pt)
  select pg_temp.mapped(f.version_id), dst, f.page, f.position, f.image_sha256, f.width_pt, f.height_pt
  from public.regulation_figures f where f.organization_id = src;

  -- ---------------------------------------------------------------- the project and its cases
  insert into id_map values (proj, gen_random_uuid());
  insert into public.projects (id, organization_id, name, created_by, created_at, all_regulations)
  select pg_temp.mapped(p.id), dst, p.name, null, p.created_at, p.all_regulations
  from public.projects p where p.id = proj;

  insert into public.project_regulations (project_id, regulation_id, organization_id, created_by, created_at)
  select pg_temp.mapped(pr.project_id), pg_temp.mapped(pr.regulation_id), dst, null, pr.created_at
  from public.project_regulations pr where pr.project_id = proj;

  insert into id_map select id, gen_random_uuid() from public.cases where project_id = proj;
  insert into public.cases (id, project_id, organization_id, name, created_by, created_at, kind,
                            old_version_id, new_version_id)
  select pg_temp.mapped(c.id), pg_temp.mapped(c.project_id), dst, c.name, null, c.created_at, c.kind,
    pg_temp.mapped(c.old_version_id), pg_temp.mapped(c.new_version_id)
  from public.cases c where c.project_id = proj;

  insert into id_map
  select f.id, gen_random_uuid() from public.case_files f join public.cases c on c.id = f.case_id
  where c.project_id = proj;
  insert into public.case_files (id, case_id, organization_id, position, storage_path, filename, format,
    media_type, bytes, sha256, status, notes, error, pages, created_by, created_at, updated_at, parsed_at)
  select pg_temp.mapped(f.id), pg_temp.mapped(f.case_id), dst, f.position,
    pg_temp.remap_path(f.storage_path, src), f.filename, f.format, f.media_type, f.bytes, f.sha256,
    f.status, pg_temp.remap_json(f.notes), f.error, f.pages, null, f.created_at, f.updated_at, f.parsed_at
  from public.case_files f join public.cases c on c.id = f.case_id
  where c.project_id = proj;

  insert into public.case_file_blocks (file_id, organization_id, seq, kind, page, label, text,
    image_path, media_type, parser, created_at)
  select pg_temp.mapped(b.file_id), dst, b.seq, b.kind, b.page, b.label, b.text,
    pg_temp.remap_path(b.image_path, src), b.media_type, b.parser, b.created_at
  from public.case_file_blocks b
  where b.file_id in (select f.id from public.case_files f join public.cases c on c.id = f.case_id
                      where c.project_id = proj)
  order by b.id;

  -- ---------------------------------------------------------------- the account
  select id into demo_user from auth.users where email = current_setting('demo.email');
  if demo_user is null then
    if pw = '' then
      raise exception 'no account % yet, and DEMO_PASSWORD is not set to create one', current_setting('demo.email');
    end if;
    demo_user := gen_random_uuid();
    -- What Auth writes for an email account confirmed by an admin. The token columns are empty
    -- strings, not null: Auth reads them as strings and fails a sign-in on a null.
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token,
      recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', demo_user, 'authenticated', 'authenticated',
      current_setting('demo.email'), extensions.crypt(pw, extensions.gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at,
      created_at, updated_at)
    values (demo_user::text, demo_user,
      jsonb_build_object('sub', demo_user::text, 'email', current_setting('demo.email'),
                         'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now());
  elsif pw <> '' then
    update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')),
      updated_at = now()
    where id = demo_user;
  end if;

  -- Viewer, and never a platform admin: a platform admin manages every organisation.
  if exists (select 1 from private.platform_admins where user_id = demo_user) then
    raise exception 'the account % is a platform admin: not giving it out', current_setting('demo.email');
  end if;
  insert into public.memberships (organization_id, user_id, role) values (dst, demo_user, 'viewer');

  -- ---------------------------------------------------------------- the runs
  insert into id_map select id, gen_random_uuid() from chosen_runs;
  -- Started by the demo account: runs.created_by may not be empty, and nobody else is in the
  -- organisation. The trace says which model wrote it and when.
  insert into public.runs (id, created_at, updated_at, created_by, task, status, model, output, error,
    usage, organization_id, case_id, requested_model, agent_version)
  select pg_temp.mapped(r.id), r.created_at, r.updated_at, demo_user, r.task, r.status, r.model,
    pg_temp.remap(r.output), r.error, r.usage, dst, pg_temp.mapped(r.case_id), r.requested_model,
    r.agent_version
  from public.runs r where r.id in (select id from chosen_runs);

  insert into public.run_events (run_id, created_at, kind, payload)
  select pg_temp.mapped(e.run_id), e.created_at, e.kind, pg_temp.remap_json(e.payload)
  from public.run_events e where e.run_id in (select id from chosen_runs)
  order by e.id;

  insert into public.approvals (id, run_id, created_at, tool_call_id, tool_name, args, status, note,
    decided_by, decided_at)
  select gen_random_uuid(), pg_temp.mapped(a.run_id), a.created_at, a.tool_call_id, a.tool_name,
    pg_temp.remap_json(a.args), a.status, a.note, null, a.decided_at
  from public.approvals a where a.run_id in (select id from chosen_runs);

  insert into public.requirements (id, case_id, organization_id, run_id, ext_id, text, test_case,
    version_id, paragraph_id, paragraph_hash, regulation, version_label, page, paragraph, status,
    findings, created_at, updated_at, paragraph_superseded_at)
  select gen_random_uuid(), pg_temp.mapped(q.case_id), dst, pg_temp.mapped(q.run_id), q.ext_id, q.text,
    q.test_case, pg_temp.mapped(q.version_id), pg_temp.mapped(q.paragraph_id), q.paragraph_hash,
    q.regulation, q.version_label, q.page, q.paragraph, q.status, pg_temp.remap_json(q.findings),
    q.created_at, q.updated_at, q.paragraph_superseded_at
  from public.requirements q where q.run_id in (select id from chosen_runs);

  insert into public.run_checks (run_id, source, checked_at, submission_sha256, certivity_commit,
    agent_version, result)
  select pg_temp.mapped(k.run_id), k.source, k.checked_at, k.submission_sha256, k.certivity_commit,
    k.agent_version, pg_temp.remap_json(k.result)
  from public.run_checks k where k.run_id in (select id from chosen_runs);

  insert into id_map
  select f.id, gen_random_uuid() from public.run_files f where f.run_id in (select id from chosen_runs);
  insert into public.run_files (id, run_id, organization_id, created_at, storage_path, filename, format,
    media_type, bytes, sha256)
  select pg_temp.mapped(f.id), pg_temp.mapped(f.run_id), dst, f.created_at,
    pg_temp.remap_path(f.storage_path, src), f.filename, f.format, f.media_type, f.bytes, f.sha256
  from public.run_files f where f.run_id in (select id from chosen_runs);

  -- ---------------------------------------------------------------- the files to copy
  insert into public.storage_copies (organization_id, bucket_id, source_path, target_path)
  select dst, 'regulations', v.pdf_path, pg_temp.remap_path(v.pdf_path, src)
  from public.regulation_versions v where v.organization_id = src
  union all
  select dst, 'regulations', v.md_path, pg_temp.remap_path(v.md_path, src)
  from public.regulation_versions v where v.organization_id = src and v.md_path is not null
  union all
  select dst, 'case-files', f.storage_path, pg_temp.remap_path(f.storage_path, src)
  from public.case_files f join public.cases c on c.id = f.case_id where c.project_id = proj
  union all
  select dst, 'case-files', b.image_path, pg_temp.remap_path(b.image_path, src)
  from public.case_file_blocks b join public.case_files f on f.id = b.file_id
  join public.cases c on c.id = f.case_id
  where c.project_id = proj and b.image_path is not null
  union all
  select dst, 'case-files', f.storage_path, pg_temp.remap_path(f.storage_path, src)
  from public.run_files f where f.run_id in (select id from chosen_runs);

  insert into public.audit_events (organization_id, actor, action, detail)
  values (dst, null, 'organization.created', jsonb_build_object(
    'name', current_setting('demo.target'), 'read_only', true,
    'copied_from', current_setting('demo.source'), 'project', current_setting('demo.project'),
    'by', 'scripts/demo-org.sql'));

  select count(*) into n from chosen_runs;
  raise notice 'organisation % (%) created read-only, with % runs; account % is its viewer',
    current_setting('demo.target'), dst, n, current_setting('demo.email');
end;
$$;

\echo '== The copy, next to its source'
select o.name, o.read_only,
  (select count(*) from public.regulations x where x.organization_id = o.id) as regulations,
  (select count(*) from public.regulation_versions x where x.organization_id = o.id) as versions,
  (select count(*) from public.regulation_paragraphs x where x.organization_id = o.id) as paragraphs,
  (select count(*) from public.regulation_paragraph_keys x where x.organization_id = o.id) as keys,
  (select count(*) from public.regulation_embeddings x where x.organization_id = o.id) as vectors,
  (select count(*) from public.regulation_figures x where x.organization_id = o.id) as figures,
  (select count(*) from public.regulation_figure_descriptions x where x.organization_id = o.id) as descriptions,
  (select count(*) from public.projects x where x.organization_id = o.id) as projects,
  (select count(*) from public.cases x where x.organization_id = o.id) as cases,
  (select count(*) from public.case_files x where x.organization_id = o.id) as files,
  (select count(*) from public.runs x where x.organization_id = o.id) as runs,
  (select count(*) from public.requirements x where x.organization_id = o.id) as requirements
from public.organizations o
where o.name in (:'source', :'target')
order by o.read_only;

\echo '== Its runs'
select c.name as case_name, c.kind, r.status, r.created_at, r.model,
  (select count(*) from public.requirements q where q.run_id = r.id) as requirements,
  (select count(*) from public.requirements q where q.run_id = r.id and q.paragraph_id is null) as unlinked,
  (select count(*) from public.run_events e where e.run_id = r.id) as events
from public.runs r join public.cases c on c.id = r.case_id
join public.organizations o on o.id = r.organization_id
where o.name = :'target'
order by c.kind, r.created_at desc;

\echo '== Files to copy in Storage'
select s.bucket_id, count(*) as files
from public.storage_copies s join public.organizations o on o.id = s.organization_id
where o.name = :'target' and s.copied_at is null
group by s.bucket_id;

commit;
