-- Stored check results (SYS-11, IF-4, #51): people read the checks of the runs they can read and
-- nobody else's, only the agent writes them, one row per run and source, gone with the run.
begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin1@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer1@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'admin2@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Org one'),
  ('10000000-0000-0000-0000-000000000002', 'Org two');

insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'admin'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'viewer'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', 'admin');

insert into public.runs (id, organization_id, created_by, task, status, output) values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'one', 'succeeded', '{}'),
  ('22222222-2222-2222-2222-222222222222', '10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-00000000000d', 'two', 'succeeded', '{}');

-- What the agent writes, with the secret key.
set local role service_role;

insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, agent_version, result) values
  ('11111111-1111-1111-1111-111111111111', 'output', repeat('a', 64), 'abc1234', 'deadbeef', '{"valid": true}'),
  ('11111111-1111-1111-1111-111111111111', 'stored', repeat('b', 64), 'abc1234', null, '{"valid": false}'),
  ('22222222-2222-2222-2222-222222222222', 'output', repeat('c', 64), 'abc1234', null, '{"valid": true}');

select throws_ok(
  $$ insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, result)
     values ('11111111-1111-1111-1111-111111111111', 'output', repeat('d', 64), 'abc1234', '{}') $$,
  '23505', null, 'one row per run and source: a new check replaces the old one');

select throws_ok(
  $$ insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, result)
     values ('22222222-2222-2222-2222-222222222222', 'pasted', repeat('d', 64), 'abc1234', '{}') $$,
  '23514', null, 'a source outside the list is refused');

select throws_ok(
  $$ insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, result)
     values ('22222222-2222-2222-2222-222222222222', 'stored', 'not a hash', 'abc1234', '{}') $$,
  '23514', null, 'the hash is a SHA-256 in hex');

select throws_ok(
  $$ insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, result)
     values ('22222222-2222-2222-2222-222222222222', 'stored', repeat('d', 64), 'abc1234', '[]') $$,
  '23514', null, 'the result is an object');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- a viewer of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';

select is((select count(*) from public.run_checks), 2::bigint,
  'a viewer reads both checks of their organisation''s run, not the other organisation''s');

select throws_ok(
  $$ insert into public.run_checks (run_id, source, submission_sha256, certivity_commit, result)
     values ('11111111-1111-1111-1111-111111111111', 'output', repeat('e', 64), 'x', '{"valid": true}') $$,
  '42501', null, 'people do not write checks');

-- ---------------------------------------------------------------- an admin of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select throws_ok(
  $$ update public.run_checks set result = '{"valid": true}' where source = 'stored' $$,
  '42501', null, 'not even an admin edits a stored score');

select throws_ok(
  $$ update public.runs set agent_version = 'forged' $$,
  '42501', null, 'nor the version that wrote a run');

reset role;
set local role anon;

select throws_ok($$ select count(*) from public.run_checks $$, '42501', null, 'a visitor reads nothing');

reset role;
delete from public.runs where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from public.run_checks where run_id = '11111111-1111-1111-1111-111111111111'),
  0::bigint, 'the checks go with their run, so purging runs purges them');

select * from finish();
rollback;
