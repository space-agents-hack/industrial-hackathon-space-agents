-- Rename and delete, a project's regulations, and the model per process (SYS-31, SYS-32, SYS-33):
-- members change their own organisation's projects and cases, viewers and other organisations
-- change nothing, and only admins set models.
begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'viewer1@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'member2@example.test'),
  ('00000000-0000-0000-0000-0000000000c4', 'admin1@example.test');

insert into public.organizations (id, name) values
  ('40000000-0000-0000-0000-000000000001', 'Org one'),
  ('40000000-0000-0000-0000-000000000002', 'Org two');

insert into public.memberships (organization_id, user_id, role) values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'member'),
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'viewer'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c3', 'member'),
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c4', 'admin');

insert into public.projects (id, organization_id, name) values
  ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Rear lamp'),
  ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'Mirror');
insert into public.cases (id, project_id, organization_id, name) values
  ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001', 'dev-rear-lamp'),
  ('42000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000002',
   '40000000-0000-0000-0000-000000000001', 'mirror-a');
insert into storage.objects (bucket_id, name) values
  ('case-files', '40000000-0000-0000-0000-000000000001/42000000-0000-0000-0000-000000000001/0-spec.md');
insert into public.case_files (id, case_id, organization_id, storage_path, filename, format, bytes) values
  ('43000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001/42000000-0000-0000-0000-000000000001/0-spec.md', 'spec.md', 'md', 10);
insert into public.runs (id, task, organization_id, case_id, created_by) values
  ('44000000-0000-0000-0000-000000000001', 'x', '40000000-0000-0000-0000-000000000001',
   '42000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1');
insert into public.regulations (id, organization_id, code, slug, kind) values
  ('45000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'UN R48', 'UN_R48', 'UN R'),
  ('45000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'UN R48', 'UN_R48', 'UN R');

set local role authenticated;

-- ---------------------------------------------------------------- a viewer of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c2", "role": "authenticated"}';

update public.projects set name = 'Renamed by a viewer';
select is((select count(*) from public.projects where name = 'Rear lamp'), 1::bigint, 'a viewer renames nothing');
delete from public.cases;
select is((select count(*) from public.cases), 2::bigint, 'a viewer deletes no case');
delete from public.case_files;
select is((select count(*) from public.case_files), 1::bigint, 'a viewer removes no file');
select throws_ok(
  $$ insert into public.project_regulations (project_id, regulation_id, organization_id)
     values ('41000000-0000-0000-0000-000000000001', '45000000-0000-0000-0000-000000000001',
             '40000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'a viewer chooses no regulation');

-- ---------------------------------------------------------------- a member of org 2
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c3", "role": "authenticated"}';

update public.cases set name = 'Theirs now';
delete from public.projects;
reset role;
select is((select count(*) from public.cases where name = 'Theirs now'), 0::bigint,
  'another organisation renames no case');
select is((select count(*) from public.projects), 2::bigint, 'nor deletes a project');
set local role authenticated;

-- ---------------------------------------------------------------- a member of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c1", "role": "authenticated"}';

select lives_ok(
  $$ update public.projects set name = 'Rear lamp, model X'
     where id = '41000000-0000-0000-0000-000000000001' $$,
  'a member renames a project');
select is((select name from public.projects where id = '41000000-0000-0000-0000-000000000001'),
  'Rear lamp, model X', 'and the name changes');
select throws_ok(
  $$ update public.projects set organization_id = '40000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'a project cannot be moved to another organisation');
select lives_ok(
  $$ update public.cases set name = 'dev-rear-lamp B' where id = '42000000-0000-0000-0000-000000000001' $$,
  'a member renames a case');

select lives_ok(
  $$ update public.projects set all_regulations = false where id = '41000000-0000-0000-0000-000000000001' $$,
  'a member narrows a project to chosen regulations');
select lives_ok(
  $$ insert into public.project_regulations (project_id, regulation_id, organization_id)
     values ('41000000-0000-0000-0000-000000000001', '45000000-0000-0000-0000-000000000001',
             '40000000-0000-0000-0000-000000000001') $$,
  'and chooses one from the library');
select throws_ok(
  $$ insert into public.project_regulations (project_id, regulation_id, organization_id)
     values ('41000000-0000-0000-0000-000000000001', '45000000-0000-0000-0000-000000000002',
             '40000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'a regulation from another organisation''s library cannot be chosen');

select lives_ok(
  $$ delete from public.case_files where id = '43000000-0000-0000-0000-000000000001' $$,
  'a member removes a file from a case');
select is((select count(*) from public.case_files), 0::bigint, 'and it is gone');
select lives_ok(
  $$ delete from public.projects where id = '41000000-0000-0000-0000-000000000002' $$,
  'a member deletes a project');
select is((select count(*) from public.cases where id = '42000000-0000-0000-0000-000000000002'), 0::bigint,
  'its cases go with it');
select is((select case_id from public.runs where id = '44000000-0000-0000-0000-000000000001'), null::uuid,
  'and their runs stay, without a case');

select throws_ok(
  $$ select public.set_organization_model('40000000-0000-0000-0000-000000000001', 'transcription',
                                          'anthropic:claude-sonnet-5-5') $$,
  '42501', null, 'a member does not set models');

-- ---------------------------------------------------------------- an admin of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c4", "role": "authenticated"}';

select lives_ok(
  $$ select public.set_organization_model('40000000-0000-0000-0000-000000000001', 'transcription',
                                          'anthropic:claude-sonnet-5-5') $$,
  'an admin sets the transcription model');
select lives_ok(
  $$ select public.set_organization_model('40000000-0000-0000-0000-000000000001', 'transcription', '') $$,
  'and an empty one goes back to the default');
select is((select count(*) from public.organization_models), 0::bigint, 'leaving no row');
select lives_ok(
  $$ select public.set_organization_model('40000000-0000-0000-0000-000000000001', 'embedding',
                                          'openrouter:openai/text-embedding-3-large') $$,
  'an admin picks an embedding model the indexer can call');
select throws_ok(
  $$ select public.set_organization_model('40000000-0000-0000-0000-000000000001', 'embedding',
                                          'anthropic:claude-haiku-5-5') $$,
  '22023', null, 'and not one from a provider without an embeddings endpoint');

select * from finish();
rollback;
