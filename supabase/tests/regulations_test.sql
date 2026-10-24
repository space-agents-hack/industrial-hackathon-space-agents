-- The regulation library: each organisation has its own; everyone in it reads it, its admins
-- start imports, and nobody but the agent writes it. If one of these fails, either a colleague
-- cannot see what their admin imported, another client can, or someone can rewrite the documents
-- every answer cites.
begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin1@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin2@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'platform@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-0000000000a1', 'Org one'),
  ('10000000-0000-0000-0000-0000000000a2', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'member'),
  ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', 'admin');
insert into private.platform_admins (user_id, note)
values ('00000000-0000-0000-0000-0000000000a4', 'test');

-- ---------------------------------------------------------------- the agent records versions
set local role service_role;

select lives_ok($$
  select public.record_regulation_version('10000000-0000-0000-0000-0000000000a1', null, 'UN R10', 'UN_R10',
    'UN R', 'Electromagnetic compatibility', null, '7.2.0', 'latest', 'adopted', 'UN R10, version 7.2.0',
    'UN_R10_latest.pdf', repeat('a', 64), 1000,
    '10000000-0000-0000-0000-0000000000a1/UN_R10/7.2.0/UN_R10_7.2.0.pdf') $$,
  'the agent records a version in org one''s library');

select lives_ok($$
  select public.record_regulation_version('10000000-0000-0000-0000-0000000000a1', null, 'UN R10', 'UN_R10',
    'UN R', null, null, '7.3.0', 'latest', 'adopted', 'UN R10, version 7.3.0', 'UN_R10_latest.pdf',
    repeat('b', 64), 1000, '10000000-0000-0000-0000-0000000000a1/UN_R10/7.3.0/UN_R10_7.3.0.pdf') $$,
  'the agent records a newer latest version of the same regulation');

select lives_ok($$
  select public.record_regulation_version('10000000-0000-0000-0000-0000000000a2', null, 'UN R10', 'UN_R10',
    'UN R', null, null, '7.2.0', 'base', 'adopted', null, 'UN_R10_base.pdf',
    repeat('a', 64), 1000, '10000000-0000-0000-0000-0000000000a2/UN_R10/7.2.0/UN_R10_7.2.0.pdf') $$,
  'the same regulation can be in another organisation''s library too');

select is((select role from public.regulation_versions
           where version_label = '7.3.0' and organization_id = '10000000-0000-0000-0000-0000000000a1'),
  'latest', 'the newer version takes the latest role');
select is((select role from public.regulation_versions
           where version_label = '7.2.0' and organization_id = '10000000-0000-0000-0000-0000000000a1'),
  null, 'the older version keeps its row and loses the role');
select is((select role from public.regulation_versions
           where version_label = '7.2.0' and organization_id = '10000000-0000-0000-0000-0000000000a2'),
  'base', 'another organisation''s roles are its own');
select is((select title from public.regulations
           where code = 'UN R10' and organization_id = '10000000-0000-0000-0000-0000000000a1'),
  'Electromagnetic compatibility', 'an import without a title does not erase the one already known');

update public.regulation_versions set md_path = 'x.md', page_count = 150
where version_label = '7.3.0';
select public.record_regulation_version('10000000-0000-0000-0000-0000000000a1', null, 'UN R10', 'UN_R10',
  'UN R', null, null, '7.3.0', 'latest', 'enforced', null, 'UN_R10_latest.pdf', repeat('b', 64), 1000,
  '10000000-0000-0000-0000-0000000000a1/UN_R10/7.3.0/UN_R10_7.3.0.pdf');
select is((select md_path from public.regulation_versions where version_label = '7.3.0'), 'x.md',
  'the same file again keeps what was extracted from it');
select public.record_regulation_version('10000000-0000-0000-0000-0000000000a1', null, 'UN R10', 'UN_R10',
  'UN R', null, null, '7.3.0', 'latest', 'enforced', null, 'UN_R10_latest.pdf', repeat('c', 64), 1000,
  '10000000-0000-0000-0000-0000000000a1/UN_R10/7.3.0/UN_R10_7.3.0.pdf');
select is((select md_path from public.regulation_versions where version_label = '7.3.0'), null,
  'a different file under the same version drops the stale extraction');

reset role;

select is((select public from storage.buckets where id = 'regulations'), false,
  'the regulations bucket exists and is private');

-- ---------------------------------------------------------------- a visitor, not signed in
set local role anon;

select throws_ok($$ select count(*) from public.regulations $$, '42501', null,
  'anon cannot read any library');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- a member of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}';

select is((select count(*) from public.regulation_versions), 2::bigint,
  'a member reads their organisation''s library and only that');
select throws_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a1', 'index.json', '[{}]'::jsonb) $$,
  '42501', null, 'a member cannot start an import');
select throws_ok($$ update public.regulation_versions set role = null $$, '42501', null,
  'a member cannot change the library');
select throws_ok(
  $$ select public.record_regulation_version('10000000-0000-0000-0000-0000000000a1', null, 'UN R1', 'UN_R1',
       'UN R', null, null, '1.0.0', null, null, null, 'x.pdf', repeat('d', 64), 1, 'x/UN_R1/1.0.0/x.pdf') $$,
  '42501', null, 'a signed-in person cannot record a version');

-- ---------------------------------------------------------------- the admin of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';

select throws_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a1', 'index.json', '{}'::jsonb) $$,
  '22023', null, 'an index that is not a list is refused');
select lives_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a1', 'index.json',
       '[{"regulation": "UN R10"}]'::jsonb) $$,
  'an admin starts an import into their organisation''s library');
select throws_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a1', 'again.json',
       '[{"regulation": "UN R10"}]'::jsonb) $$,
  '55000', null, 'a second import into the same library waits until the first one ends');
select throws_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a2', 'index.json',
       '[{"regulation": "UN R10"}]'::jsonb) $$,
  '42501', null, 'an admin cannot import into another organisation''s library');
select throws_ok($$ select index from public.regulation_imports $$, '42501', null,
  'the uploaded index with its download links is not readable from a browser');
select ok(exists (select 1 from public.audit_events
                  where action = 'regulations.import_started'
                    and organization_id = '10000000-0000-0000-0000-0000000000a1'),
  'starting an import is in the organisation''s audit log');

-- ---------------------------------------------------------------- the member again
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}';

select is((select count(*) from public.regulation_imports), 1::bigint,
  'a member sees the imports of their organisation');

-- ---------------------------------------------------------------- the admin of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a3", "role": "authenticated"}';

select is((select count(*) from public.regulation_imports), 0::bigint,
  'another organisation does not see the import');
select lives_ok(
  $$ select public.create_regulation_import('10000000-0000-0000-0000-0000000000a2', 'index.json',
       '[{"regulation": "UN R10"}]'::jsonb) $$,
  'another organisation imports at the same time into its own library');

-- ---------------------------------------------------------------- a platform admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a4", "role": "authenticated"}';

select lives_ok(
  $$ select public.cancel_regulation_import((select id from public.regulation_imports
       where organization_id = '10000000-0000-0000-0000-0000000000a1')) $$,
  'a platform admin cancels any organisation''s import');

select * from finish();
rollback;
