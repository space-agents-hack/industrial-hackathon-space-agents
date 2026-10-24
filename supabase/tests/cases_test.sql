-- Projects, cases and their parsed files (ADR-0006, issue #8): every role of an organisation reads
-- its cases, members create them, and nothing crosses to another organisation.
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'viewer1@example.test'),
  ('00000000-0000-0000-0000-0000000000b3', 'member2@example.test');

insert into public.organizations (id, name) values
  ('30000000-0000-0000-0000-000000000001', 'Org one'),
  ('30000000-0000-0000-0000-000000000002', 'Org two');

insert into public.memberships (organization_id, user_id, role) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'member'),
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2', 'viewer'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b3', 'member');

-- Org two's project, as the owner, for the cross-organisation checks.
insert into public.projects (id, organization_id, name) values
  ('31000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Theirs');

set local role authenticated;

-- ---------------------------------------------------------------- a member of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.projects (id, organization_id, name)
     values ('31000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Rear lamp') $$,
  'a member creates a project');

select lives_ok(
  $$ insert into public.cases (id, project_id, organization_id, name)
     values ('32000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001',
             '30000000-0000-0000-0000-000000000001', 'dev-rear-lamp') $$,
  'a member creates a case in it');

select throws_ok(
  $$ insert into public.cases (project_id, organization_id, name)
     values ('31000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'x') $$,
  '23503', null, 'a case cannot go into another organisation''s project');

select throws_ok(
  $$ insert into public.projects (organization_id, name)
     values ('30000000-0000-0000-0000-000000000002', 'Not mine') $$,
  '42501', null, 'a member cannot create a project in another organisation');

insert into storage.objects (bucket_id, name) values
  ('case-files', '30000000-0000-0000-0000-000000000001/32000000-0000-0000-0000-000000000001/1-spec.md');

select lives_ok(
  $$ insert into public.case_files (case_id, organization_id, position, storage_path, filename, format, bytes)
     values ('32000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 0,
             '30000000-0000-0000-0000-000000000001/32000000-0000-0000-0000-000000000001/1-spec.md',
             'spec.md', 'md', 1299) $$,
  'a member adds an uploaded file to the case');

select is((select status from public.case_files), 'pending', 'it waits to be parsed');

select throws_ok(
  $$ insert into public.case_files (case_id, organization_id, storage_path, filename, format, bytes)
     values ('32000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
             '30000000-0000-0000-0000-000000000001/32000000-0000-0000-0000-000000000001/2-missing.pdf',
             'missing.pdf', 'pdf', 10) $$,
  '42501', null, 'a file that was never uploaded cannot be added');

select throws_ok(
  $$ insert into public.case_files (case_id, organization_id, storage_path, filename, format, bytes)
     values ('32000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
             '30000000-0000-0000-0000-000000000001/some-other-case/1-spec.md', 'spec.md', 'md', 10) $$,
  '42501', null, 'the object must sit in that case''s folder');

select throws_ok(
  $$ update public.case_files set status = 'parsed' $$,
  '42501', null, 'only the agent changes a file''s parse status');

select throws_ok(
  $$ insert into public.case_file_blocks (file_id, organization_id, seq, kind, text, parser)
     select id, organization_id, 0, 'text', 'forged', 'pypdf' from public.case_files $$,
  '42501', null, 'only the agent writes parsed content');

select lives_ok(
  $$ insert into public.runs (task, organization_id, case_id)
     values ('Find the requirements.', '30000000-0000-0000-0000-000000000001',
             '32000000-0000-0000-0000-000000000001') $$,
  'a member starts a run on the case');

select throws_ok(
  $$ insert into public.runs (task, organization_id, case_id)
     values ('x', '30000000-0000-0000-0000-000000000002', '32000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'a run cannot name a case from an organisation it is not started in');

-- ---------------------------------------------------------------- what the agent writes
reset role;
insert into public.case_file_blocks (file_id, organization_id, seq, kind, text, parser)
select id, organization_id, 0, 'text', '# Rear lamp', 'text' from public.case_files;
set local role authenticated;

-- ---------------------------------------------------------------- a viewer of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b2", "role": "authenticated"}';

select is((select count(*) from public.cases), 1::bigint, 'a viewer reads the organisation''s cases');
select is((select count(*) from public.case_file_blocks), 1::bigint, 'and their parsed content');

-- ---------------------------------------------------------------- a member of org 2
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b3", "role": "authenticated"}';

select is((select count(*) from public.cases), 0::bigint, 'another organisation sees no case');
select is((select count(*) from public.case_file_blocks), 0::bigint, 'nor any parsed content');

select * from finish();
rollback;
