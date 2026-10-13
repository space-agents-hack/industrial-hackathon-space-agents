-- What a signed-in user, a second user and a visitor can and cannot do. These are the rules the
-- web relies on; if one of these fails, the browser can do something the design says it cannot.
begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');

-- Rows the agent would have written (this session is the table owner, so RLS does not apply).
insert into public.runs (id, created_by, task, status)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a',
        'seeded run', 'awaiting_approval');

insert into public.approvals (id, run_id, tool_call_id, tool_name, args)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'call_1', 'plm_set_status', '{"status": "hold"}');

insert into public.run_state (run_id, conversation)
values ('11111111-1111-1111-1111-111111111111', '{"messages": []}');

-- A visitor who is not signed in.
set local role anon;

select throws_ok(
  $$ select count(*) from public.runs $$,
  '42501', null, 'anon cannot read runs'
);

select throws_ok(
  $$ insert into public.runs (task) values ('x') $$,
  '42501', null, 'anon cannot start a run'
);

reset role;

-- User A.
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

-- Counted by id: a developer's local database has runs of its own.
select is(
  (select count(*) from public.runs where id = '11111111-1111-1111-1111-111111111111'), 1::bigint,
  'a signed-in user reads runs'
);

select lives_ok(
  $$ insert into public.runs (task) values ('triage ECN-1001') $$,
  'a signed-in user starts a run as themselves'
);

select throws_ok(
  $$ insert into public.runs (task, created_by)
     values ('x', '00000000-0000-0000-0000-00000000000b') $$,
  '42501', null, 'a user cannot start a run as someone else'
);

select throws_ok(
  $$ insert into public.runs (task, status) values ('x', 'succeeded') $$,
  '42501', null, 'a user cannot insert a run that is already finished'
);

select throws_ok(
  $$ update public.runs set status = 'succeeded' $$,
  '42501', null, 'a user cannot change a run'
);

select throws_ok(
  $$ insert into public.run_events (run_id, kind)
     values ('11111111-1111-1111-1111-111111111111', 'text') $$,
  '42501', null, 'a user cannot write events'
);

select throws_ok(
  $$ select count(*) from public.run_state $$,
  '42501', null, 'a user cannot read the saved conversation'
);

select throws_ok(
  $$ update public.approvals set args = '{"status": "released"}' $$,
  '42501', null, 'a user cannot rewrite what the agent asked for'
);

select throws_ok(
  $$ update public.approvals
     set status = 'approved', decided_by = '00000000-0000-0000-0000-00000000000b' $$,
  '42501', null, 'a user cannot decide in someone else''s name'
);

select lives_ok(
  $$ update public.approvals
     set status = 'approved', decided_by = '00000000-0000-0000-0000-00000000000a'
     where id = '22222222-2222-2222-2222-222222222222' $$,
  'a user decides a pending approval'
);

select isnt(
  (select decided_at from public.approvals where id = '22222222-2222-2222-2222-222222222222'),
  null,
  'the decision time is stamped by the database'
);

-- User B tries to overturn the decision. The row is no longer pending, so the policy hides it
-- from the update and nothing changes.
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

update public.approvals
set status = 'denied', decided_by = '00000000-0000-0000-0000-00000000000b'
where id = '22222222-2222-2222-2222-222222222222';

select is(
  (select status from public.approvals where id = '22222222-2222-2222-2222-222222222222'),
  'approved',
  'a decision cannot be changed once made'
);

select * from finish();
rollback;
