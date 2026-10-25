-- Read-only organisations (SYS-47, #59): whatever the role, a member changes nothing there, the
-- web is told so, a platform admin still manages it, and the copy queue is closed to browsers.
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin-ro@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'viewer-ro@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'platform@example.test');

insert into private.platform_admins (user_id, note) values
  ('00000000-0000-0000-0000-0000000000d3', 'test');

insert into public.organizations (id, name, read_only) values
  ('50000000-0000-0000-0000-000000000001', 'Frozen', true),
  ('50000000-0000-0000-0000-000000000002', 'Open', false);

-- The same person is admin of both: only the flag differs.
insert into public.memberships (organization_id, user_id, role) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 'admin'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000d1', 'admin'),
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 'viewer');

insert into public.projects (id, organization_id, name) values
  ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'dev-rear-lamp');
insert into public.cases (id, project_id, organization_id, name) values
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'dev-rear-lamp');

select throws_ok(
  $$ insert into public.storage_copies (organization_id, bucket_id, source_path, target_path)
     values ('50000000-0000-0000-0000-000000000001', 'regulations', 'a/b.pdf',
             '50000000-0000-0000-0000-000000000002/b.pdf') $$,
  '23514', null, 'a copy lands only in its own organisation''s folder');

set local role authenticated;

-- ---------------------------------------------------------------- an admin of both
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

select is(
  (select o -> 'role' from jsonb_array_elements(public.my_access() -> 'organizations') o
   where o ->> 'id' = '50000000-0000-0000-0000-000000000001'),
  '"viewer"'::jsonb, 'an admin of a read-only organisation is told they are a viewer there');
select is(
  (select o -> 'read_only' from jsonb_array_elements(public.my_access() -> 'organizations') o
   where o ->> 'id' = '50000000-0000-0000-0000-000000000001'),
  'true'::jsonb, 'and that it is read-only');
select is(
  (select o -> 'role' from jsonb_array_elements(public.my_access() -> 'organizations') o
   where o ->> 'id' = '50000000-0000-0000-0000-000000000002'),
  '"admin"'::jsonb, 'and stays admin where it is not');

select throws_ok(
  $$ insert into public.projects (organization_id, name)
     values ('50000000-0000-0000-0000-000000000001', 'New') $$,
  '42501', null, 'an admin creates no project in a read-only organisation');
select lives_ok(
  $$ insert into public.projects (organization_id, name)
     values ('50000000-0000-0000-0000-000000000002', 'New') $$,
  'but still does in a writable one');
select throws_ok(
  $$ insert into public.runs (task, organization_id, case_id)
     values ('x', '50000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'starts no run');
update public.cases set name = 'Renamed' where organization_id = '50000000-0000-0000-0000-000000000001';
select is((select count(*) from public.cases where name = 'Renamed'), 0::bigint, 'renames no case');
delete from public.projects where organization_id = '50000000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.projects where organization_id = '50000000-0000-0000-0000-000000000001'),
  1::bigint, 'deletes no project, and still reads it');
select throws_ok(
  $$ select public.rename_organization('50000000-0000-0000-0000-000000000001', 'Thawed') $$,
  '42501', null, 'renames not the organisation');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('case-files', '50000000-0000-0000-0000-000000000001/52000000-0000-0000-0000-000000000001/x.md') $$,
  '42501', null, 'uploads no file');
select throws_ok(
  $$ select * from public.storage_copies $$,
  '42501', null, 'and cannot read the copy queue');
select throws_ok(
  $$ update public.organizations set read_only = false
     where id = '50000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'nor unfreeze it');

-- ---------------------------------------------------------------- its viewer
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d2", "role": "authenticated"}';

select is((select count(*) from public.cases), 1::bigint, 'a viewer reads the cases');

-- ---------------------------------------------------------------- a platform admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d3", "role": "authenticated"}';

select ok(private.can_manage('50000000-0000-0000-0000-000000000001'),
  'a platform admin still manages its people');
select is(
  (select o -> 'read_only' from jsonb_array_elements(public.my_access() -> 'all_organizations') o
   where o ->> 'id' = '50000000-0000-0000-0000-000000000001'),
  'true'::jsonb, 'and sees which organisations are read-only');

select * from finish();
rollback;
