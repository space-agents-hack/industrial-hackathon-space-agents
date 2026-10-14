-- Who can see and do what, organisation by organisation. These are the rules the web and the
-- agent rely on; if one fails, someone can see another client's data or change what they
-- should only read.
begin;

create extension if not exists pgtap with schema extensions;

select plan(42);

-- People: an admin, a member and a viewer of org 1; an admin of org 2; a platform admin with no
-- membership anywhere.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin1@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'member1@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer1@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'admin2@example.test'),
  ('00000000-0000-0000-0000-00000000000e', 'platform@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Org one'),
  ('10000000-0000-0000-0000-000000000002', 'Org two');

insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'admin'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'member'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'viewer'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', 'admin');

insert into private.platform_admins (user_id, note)
values ('00000000-0000-0000-0000-00000000000e', 'test');

-- What the agent would have written (as the table owner, so RLS does not apply).
insert into public.runs (id, organization_id, created_by, task, status) values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'org one run', 'awaiting_approval');

insert into public.approvals (id, run_id, tool_call_id, tool_name, args) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'call_1', 'plm_set_ecn_status', '{"status": "hold"}');

insert into public.run_state (run_id, conversation)
values ('11111111-1111-1111-1111-111111111111', '{"messages": []}');

-- ---------------------------------------------------------------- a visitor, not signed in
set local role anon;

select throws_ok($$ select count(*) from public.runs $$, '42501', null, 'anon cannot read runs');
select throws_ok($$ select public.my_access() $$, '42501', null, 'anon cannot ask what it may do');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- the admin of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select is((select count(*) from public.runs where id = '11111111-1111-1111-1111-111111111111'),
  1::bigint, 'an admin reads their organisation''s run');

select throws_ok(
  $$ insert into public.runs (task, organization_id, output)
     values ('x', '10000000-0000-0000-0000-000000000001', 'forged') $$,
  '42501', null, 'a user cannot write the columns that belong to the agent');

select throws_ok($$ update public.runs set status = 'succeeded' $$, '42501', null,
  'a user cannot change a run');

select throws_ok($$ select count(*) from public.run_state $$, '42501', null,
  'a user cannot read the saved conversation');

select lives_ok(
  $$ select public.update_organization_settings('10000000-0000-0000-0000-000000000001',
       'openrouter:anthropic/claude-sonnet-4.6', 20, 50) $$,
  'an admin changes the settings');

select lives_ok(
  $$ select public.set_provider_key('10000000-0000-0000-0000-000000000001', 'openrouter',
       'sk-or-v1-0123456789abcdef', 'pasted') $$,
  'an admin stores a provider key');

select is((select last4 from public.provider_connections
           where organization_id = '10000000-0000-0000-0000-000000000001'), 'cdef',
  'people see the last four characters of a key');

select throws_ok(
  $$ select secret_id from public.provider_connections $$, '42501', null,
  'the Vault handle of a key is not readable');

select throws_ok(
  $$ select public.read_provider_key('10000000-0000-0000-0000-000000000001', 'openrouter') $$,
  '42501', null, 'a signed-in user cannot read a key back');

select throws_ok(
  $$ select public.set_provider_key('10000000-0000-0000-0000-000000000001', 'openai', 'short') $$,
  '22023', null, 'something that is not a key is refused');

select ok((select count(*) from public.audit_events
           where organization_id = '10000000-0000-0000-0000-000000000001') >= 2,
  'settings and key changes are in the audit log');

select ok(not exists (select 1 from public.audit_events where detail::text like '%0123456789ab%'),
  'the audit log never holds a key');

select is((select count(*) from public.organization_people('10000000-0000-0000-0000-000000000001')),
  3::bigint, 'an admin sees the people of their organisation with their email');

select throws_ok(
  $$ select public.set_member('10000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-00000000000a', 'member') $$,
  '23514', null, 'the last admin cannot demote themselves');

select throws_ok($$ select public.create_organization('mine') $$, '42501', null,
  'an organisation admin cannot create organisations');

select lives_ok(
  $$ update public.approvals set status = 'approved', decided_by = '00000000-0000-0000-0000-00000000000a'
     where id = '22222222-2222-2222-2222-222222222222' $$,
  'an admin decides a pending approval');

select isnt((select decided_at from public.approvals where id = '22222222-2222-2222-2222-222222222222'),
  null, 'the decision time is stamped by the database');

select ok(public.can_reset_password('00000000-0000-0000-0000-00000000000b'),
  'an admin may reset the password of a member of only their organisation');
select ok(not public.can_reset_password('00000000-0000-0000-0000-00000000000d'),
  'an admin may not reset the password of someone in another organisation');
select ok(not public.can_reset_password('00000000-0000-0000-0000-00000000000e'),
  'an admin may not reset the password of a platform admin');

-- ---------------------------------------------------------------- a member of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select lives_ok(
  $$ insert into public.runs (task, organization_id) values ('member run', '10000000-0000-0000-0000-000000000001') $$,
  'a member starts a run in their organisation');

select throws_ok(
  $$ select public.update_organization_settings('10000000-0000-0000-0000-000000000001', 'x', 1, 1) $$,
  '42501', null, 'a member cannot change the settings');

select throws_ok(
  $$ select public.set_provider_key('10000000-0000-0000-0000-000000000001', 'openai', 'sk-proj-0123456789abcdef') $$,
  '42501', null, 'a member cannot store keys');

select is((select count(*) from public.audit_events), 0::bigint, 'a member does not read the audit log');

select is((select model from public.organization_settings
           where organization_id = '10000000-0000-0000-0000-000000000001'),
  'openrouter:anthropic/claude-sonnet-4.6', 'a member reads the settings');

select throws_ok(
  $$ select * from public.organization_people('10000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'a member does not see the list of people');

select ok((select count(*) from public.organization_usage('10000000-0000-0000-0000-000000000001')) >= 1,
  'a member sees their organisation''s usage');

-- ---------------------------------------------------------------- a viewer of org 1
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';

select is((select count(*) from public.runs where organization_id = '10000000-0000-0000-0000-000000000001'),
  2::bigint, 'a viewer reads their organisation''s runs');

select throws_ok(
  $$ insert into public.runs (task, organization_id) values ('x', '10000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'a viewer cannot start a run');

select is((public.my_access() -> 'organizations' -> 0 ->> 'role'), 'viewer',
  'my_access tells the web the person is a viewer');

-- ---------------------------------------------------------------- the admin of org 2
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000d", "role": "authenticated"}';

select is((select count(*) from public.runs), 0::bigint, 'another organisation sees none of these runs');
select is((select count(*) from public.provider_connections), 0::bigint,
  'another organisation does not see which keys exist');
select is((select count(*) from public.organization_settings), 0::bigint,
  'another organisation does not see the settings');

select throws_ok(
  $$ insert into public.runs (task, organization_id) values ('x', '10000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'nobody starts a run in an organisation they are not in');

-- ---------------------------------------------------------------- a platform admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';

select is((select count(*) from public.runs where organization_id = '10000000-0000-0000-0000-000000000001'),
  2::bigint, 'a platform admin reads every organisation');

select lives_ok($$ select public.create_organization('Client three') $$,
  'a platform admin creates organisations');

select ok(public.can_reset_password('00000000-0000-0000-0000-00000000000d'),
  'a platform admin may reset anyone''s password');

-- ---------------------------------------------------------------- the agent (secret key)
reset role;
set local role service_role;

select is(public.read_provider_key('10000000-0000-0000-0000-000000000001', 'openrouter'),
  'sk-or-v1-0123456789abcdef', 'the agent reads the key back from Vault');

-- Deleting an organisation must not leave its keys in Vault.
reset role;
select is((select count(*) from vault.secrets where name like 'provider:10000000-0000-0000-0000-000000000001:%'),
  1::bigint, 'the key is in Vault while the organisation exists');
delete from public.organizations where id = '10000000-0000-0000-0000-000000000001';
select is((select count(*) from vault.secrets where name like 'provider:10000000-0000-0000-0000-000000000001:%'),
  0::bigint, 'deleting the organisation deletes its keys from Vault');

select * from finish();
rollback;
