-- What the demo account can and cannot do, checked in production as that account (SYS-47, #59).
-- Run after scripts/demo-org.sql and its file copy:
--
--   DEMO_PASSWORD=... psql "$DB_URL" -v ON_ERROR_STOP=1 -v email=demo@certivity.demo \
--     -v target=certivity -v source=team-09 -f scripts/demo-org-verify.sql
--
-- It acts through the same roles and row-level security a signed-in browser gets (role
-- `authenticated`, the account's id in the JWT claims), so a pass here is the policies' answer,
-- not this script's opinion. Every write it tries is inside one transaction that is rolled back,
-- so a policy that wrongly lets one through still leaves nothing behind. It stops with an error
-- if any check fails.
--
-- What it does not check: signing in through Supabase Auth (the password is compared with the
-- stored hash instead), and what the web and the agent show or refuse; those have their own tests.

\set ON_ERROR_STOP 1
\getenv demo_password DEMO_PASSWORD
\if :{?demo_password}
\else
  \set demo_password ''
\endif

begin;

create temp table verdicts (n serial, what text, ok boolean, detail text) on commit drop;
grant all on verdicts to authenticated;
grant usage on sequence verdicts_n_seq to authenticated;

select set_config('demo.email', lower(:'email'), true) as s1,
       set_config('demo.target', :'target', true) as s2,
       set_config('demo.source', :'source', true) as s3,
       set_config('demo.password', :'demo_password', true) as s4 \gset ignored_

do $$
declare
  uid uuid;
  dst uuid;
  src uuid;
  claims text;
begin
  select id into uid from auth.users where lower(email) = current_setting('demo.email');
  select id into dst from public.organizations where name = current_setting('demo.target');
  select id into src from public.organizations where name = current_setting('demo.source');
  if uid is null or dst is null or src is null then
    raise exception 'missing: account %, organisation %, source %', uid, dst, src;
  end if;

  insert into verdicts (what, ok, detail)
  select 'the organisation is read-only', o.read_only, null from public.organizations o where o.id = dst;
  insert into verdicts (what, ok, detail)
  select 'the account is confirmed and no platform admin',
         u.email_confirmed_at is not null
           and not exists (select 1 from private.platform_admins a where a.user_id = uid), null
  from auth.users u where u.id = uid;
  insert into verdicts (what, ok, detail)
  select 'its only membership is viewer of the copy',
         count(*) = 1 and bool_and(m.organization_id = dst and m.role = 'viewer' and m.status = 'active'),
         string_agg(m.role || ' in ' || m.organization_id, ', ')
  from public.memberships m where m.user_id = uid;
  if current_setting('demo.password') <> '' then
    insert into verdicts (what, ok, detail)
    select 'the password matches the stored hash',
           u.encrypted_password = extensions.crypt(current_setting('demo.password'), u.encrypted_password), null
    from auth.users u where u.id = uid;
  end if;
  insert into verdicts (what, ok, detail)
  select 'every queued file was copied', count(*) filter (where s.copied_at is null) = 0,
         count(*) filter (where s.copied_at is null) || ' of ' || count(*) || ' left'
  from public.storage_copies s where s.organization_id = dst;

  -- From here on, as the account.
  claims := json_build_object('sub', uid, 'role', 'authenticated')::text;
  perform set_config('request.jwt.claims', claims, true);
  set local role authenticated;

  insert into verdicts (what, ok, detail)
  select 'my_access: viewer, read-only, no platform admin',
         (a -> 'platform_admin')::boolean = false
           and jsonb_array_length(a -> 'organizations') = 1
           and a -> 'organizations' -> 0 ->> 'role' = 'viewer'
           and (a -> 'organizations' -> 0 -> 'read_only')::boolean,
         a::text
  from (select public.my_access() as a) x;

  insert into verdicts (what, ok, detail)
  select 'reads the copy', count(*) filter (where k = 'regulations') > 0 and count(*) filter (where k = 'runs') > 0
                           and count(*) filter (where k = 'files') > 0,
         count(*) filter (where k = 'regulations') || ' regulations, '
           || count(*) filter (where k = 'paragraphs') || ' paragraphs, '
           || count(*) filter (where k = 'runs') || ' runs, '
           || count(*) filter (where k = 'requirements') || ' requirements, '
           || count(*) filter (where k = 'files') || ' case files'
  from (
    select 'regulations' k from public.regulations where organization_id = dst
    union all select 'paragraphs' from public.regulation_paragraphs where organization_id = dst
    union all select 'runs' from public.runs where organization_id = dst
    union all select 'requirements' from public.requirements where organization_id = dst
    union all select 'files' from public.case_files where organization_id = dst
  ) x;

  insert into verdicts (what, ok, detail)
  select 'sees nothing of any other organisation', count(*) = 0, count(*) || ' rows'
  from (
    select 1 from public.organizations where id <> dst
    union all select 1 from public.projects where organization_id <> dst
    union all select 1 from public.regulations where organization_id <> dst
    union all select 1 from public.runs where organization_id <> dst
  ) x;

  insert into verdicts (what, ok, detail)
  select 'opens its own files in Storage, and only those',
         count(*) > 0 and bool_and(split_part(name, '/', 1) = dst::text), count(*) || ' objects'
  from storage.objects where bucket_id in ('regulations', 'case-files');

  begin
    insert into public.projects (organization_id, name) values (dst, 'demo-write-check');
    insert into verdicts (what, ok, detail) values ('creates no project', false, 'the insert went through');
  exception when insufficient_privilege then
    insert into verdicts (what, ok, detail) values ('creates no project', true, sqlerrm);
  end;

  begin
    insert into public.runs (task, organization_id, case_id)
    select 'demo-write-check', dst, c.id from public.cases c where c.organization_id = dst limit 1;
    insert into verdicts (what, ok, detail) values ('starts no run', false, 'the insert went through');
  exception when insufficient_privilege then
    insert into verdicts (what, ok, detail) values ('starts no run', true, sqlerrm);
  end;

  update public.cases set name = name || ' (edited)' where organization_id = dst;
  insert into verdicts (what, ok, detail)
  select 'edits no case', count(*) = 0, count(*) || ' changed'
  from public.cases where organization_id = dst and name like '% (edited)';

  -- A member may delete a project in a writable organisation, so this asks the read-only rule.
  begin
    delete from public.projects where organization_id = dst;
    insert into verdicts (what, ok, detail)
    select 'deletes no project', count(*) > 0, count(*) || ' still there'
    from public.projects where organization_id = dst;
  exception when insufficient_privilege then
    insert into verdicts (what, ok, detail) values ('deletes no project', true, sqlerrm);
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('case-files', dst || '/demo-write-check.md');
    insert into verdicts (what, ok, detail) values ('uploads no file', false, 'the insert went through');
  exception when insufficient_privilege then
    insert into verdicts (what, ok, detail) values ('uploads no file', true, sqlerrm);
  end;

  begin
    update public.organizations set read_only = false where id = dst;
    insert into verdicts (what, ok, detail)
    select 'cannot unfreeze it', o.read_only, 'the update went through' from public.organizations o where o.id = dst;
  exception when insufficient_privilege then
    insert into verdicts (what, ok, detail) values ('cannot unfreeze it', true, sqlerrm);
  end;

  reset role;
end
$$;

\echo '== The demo account, as itself'
select n, what, case when ok then 'pass' else 'FAIL' end as result, left(detail, 120) as detail
from verdicts order by n;

select (count(*) filter (where not ok) > 0)::text as failed from verdicts \gset
rollback;

\if :failed
  \echo 'FAILED: see the table above.'
  \quit 3
\endif
\echo 'Every check passed. Nothing was changed: the transaction was rolled back.'
