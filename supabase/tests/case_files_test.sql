-- Case files (issue #8): who can upload to the bucket, who can attach a file to a run, and who
-- can read the list. If one of these fails, one client could read another client's drawings, or
-- start a run on a file that was never uploaded.
begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'viewer1@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'member2@example.test');

insert into public.organizations (id, name) values
  ('20000000-0000-0000-0000-000000000001', 'Org one'),
  ('20000000-0000-0000-0000-000000000002', 'Org two');

insert into public.memberships (organization_id, user_id, role) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'member'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2', 'viewer'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a3', 'member');

select is((select public from storage.buckets where id = 'case-files'), false,
  'the case-files bucket exists and is private');

set local role authenticated;

-- ---------------------------------------------------------------- a member of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';

select lives_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('case-files', '20000000-0000-0000-0000-000000000001/u1/spec.md') $$,
  'a member uploads to their organisation''s folder');

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('case-files', '20000000-0000-0000-0000-000000000002/u1/spec.md') $$,
  '42501', null, 'a member cannot upload to another organisation''s folder');

select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('case-files', 'not-a-uuid/spec.md') $$,
  '42501', null, 'a path that names no organisation is refused, not an error');

select lives_ok(
  $$ select public.start_run('Find the requirements.', '20000000-0000-0000-0000-000000000001',
       '[{"storage_path": "20000000-0000-0000-0000-000000000001/u1/spec.md",
          "filename": "spec.md", "format": "md", "media_type": "text/markdown", "bytes": 1299}]') $$,
  'a member starts a run with an uploaded file');

select is((select count(*) from public.run_files), 1::bigint, 'the file is attached to the run');

select throws_ok(
  $$ select public.start_run('x', '20000000-0000-0000-0000-000000000001',
       '[{"storage_path": "20000000-0000-0000-0000-000000000001/u1/never-uploaded.pdf",
          "filename": "never-uploaded.pdf", "format": "pdf", "bytes": 10}]') $$,
  '42501', null, 'a file that was never uploaded cannot be attached');

select is((select count(*) from public.runs where task = 'x'), 0::bigint,
  'and the run is not left behind without its file');

select throws_ok(
  $$ select public.start_run('x', '20000000-0000-0000-0000-000000000001',
       '[{"storage_path": "20000000-0000-0000-0000-000000000001/u1/spec.md",
          "filename": "notes.doc", "format": "doc", "bytes": 10}]') $$,
  '23514', null, 'a format no reader exists for is refused');

select throws_ok(
  $$ insert into public.run_files (run_id, organization_id, storage_path, filename, format, bytes)
     select id, organization_id, '20000000-0000-0000-0000-000000000001/u1/spec.md', 'spec.md',
            'md', 1
     from public.runs limit 1 $$,
  '23505', null, 'the same object cannot be attached twice');

-- ---------------------------------------------------------------- a viewer of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}';

select is((select count(*) from public.run_files), 1::bigint,
  'a viewer reads the files of their organisation''s runs');

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('case-files', '20000000-0000-0000-0000-000000000001/u2/spec.md') $$,
  '42501', null, 'a viewer cannot upload');

-- ---------------------------------------------------------------- a member of org 2
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000a3", "role": "authenticated"}';

select is((select count(*) from public.run_files), 0::bigint,
  'another organisation does not see the file list');

select is((select count(*) from storage.objects where bucket_id = 'case-files'), 0::bigint,
  'nor the uploaded objects');

select * from finish();
rollback;
