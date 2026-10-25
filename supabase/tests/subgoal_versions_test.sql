-- A sub-goal case's link to the two library versions it compared (#42, SYS-45): only within its
-- organisation, written by the agent alone, and dropped (not the case) when the version goes.
begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'member1@example.test');
insert into public.organizations (id, name) values
  ('60000000-0000-0000-0000-000000000001', 'Org one'),
  ('60000000-0000-0000-0000-000000000002', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'member');
insert into public.projects (id, organization_id, name) values
  ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'Project');
insert into public.cases (id, project_id, organization_id, name, kind) values
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', 'subgoal-dev', 'subgoal');
insert into public.regulations (id, organization_id, code, slug, kind) values
  ('63000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
   'UN R900', 'UN_R900', 'UN R'),
  ('63000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000002',
   'UN R900', 'UN_R900', 'UN R');
insert into public.regulation_versions (id, regulation_id, organization_id, version_label,
                                        file_name, sha256, size_bytes, pdf_path) values
  ('64000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', '1.0.0', 'old.pdf', repeat('a', 64), 10, 'one/old.pdf'),
  ('64000000-0000-0000-0000-000000000002', '63000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', '2.0.0', 'new.pdf', repeat('b', 64), 10, 'one/new.pdf'),
  ('64000000-0000-0000-0000-000000000003', '63000000-0000-0000-0000-000000000002',
   '60000000-0000-0000-0000-000000000002', '1.0.0', 'old.pdf', repeat('a', 64), 10, 'two/old.pdf');

-- As the agent (the test runs as the owner, which bypasses grants the way the secret key does).
update public.cases
set old_version_id = '64000000-0000-0000-0000-000000000001',
    new_version_id = '64000000-0000-0000-0000-000000000002'
where id = '62000000-0000-0000-0000-000000000001';
select is((select new_version_id from public.cases where id = '62000000-0000-0000-0000-000000000001'),
  '64000000-0000-0000-0000-000000000002'::uuid, 'the agent records which versions a case compared');

select throws_ok(
  $$ update public.cases set old_version_id = '64000000-0000-0000-0000-000000000003'
     where id = '62000000-0000-0000-0000-000000000001' $$,
  '23503', null, 'a case never points at another organisation''s version');

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

select is((select old_version_id from public.cases where id = '62000000-0000-0000-0000-000000000001'),
  '64000000-0000-0000-0000-000000000001'::uuid, 'a member reads the link with the case');

select throws_ok(
  $$ update public.cases set old_version_id = null where id = '62000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'a member does not write the link');

reset role;

delete from public.regulation_versions where id = '64000000-0000-0000-0000-000000000002';
select results_eq(
  $$ select old_version_id, new_version_id from public.cases
     where id = '62000000-0000-0000-0000-000000000001' $$,
  $$ values ('64000000-0000-0000-0000-000000000001'::uuid, null::uuid) $$,
  'deleting a version keeps the case and drops only that link');

select * from finish();
rollback;
