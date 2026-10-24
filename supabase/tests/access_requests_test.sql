-- Getting into an organisation (SYS-35): a person asks to join and that organisation's admin
-- decides; a person asks for a new organisation and only a platform admin decides. Nobody
-- decides their own request, and an account grants nothing until a request is approved.
begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'newcomer@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'admin1@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'admin2@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'platform@example.test'),
  ('00000000-0000-0000-0000-0000000000d5', 'founder@example.test');

insert into public.organizations (id, name) values
  ('50000000-0000-0000-0000-000000000001', 'Org one'),
  ('50000000-0000-0000-0000-000000000002', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 'admin'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000d3', 'admin');
insert into private.platform_admins (user_id, note) values ('00000000-0000-0000-0000-0000000000d4', 'test');

set local role authenticated;

-- ---------------------------------------------------------------- a newcomer with no membership
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

select is((select count(*) from public.joinable_organizations()), 2::bigint, 'a newcomer sees both organisations to join');
select is((select count(*) from public.organizations), 0::bigint, 'and reads none of them');

select lives_ok($$ select public.request_to_join('50000000-0000-0000-0000-000000000001') $$, 'a newcomer asks to join');
select is(
  public.request_to_join('50000000-0000-0000-0000-000000000001'),
  (select id from public.access_requests where kind = 'join'),
  'asking twice returns the same open request'
);
select throws_ok(
  $$ select public.decide_access_request((select id from public.access_requests limit 1), true, 'admin') $$,
  '42501', null, 'a newcomer cannot approve their own request'
);
select is((select organization_name from public.access_requests), 'Org one', 'the request names the organisation');

-- The ids, kept where every role can read them: the tests below need them across identities.
reset role;
create temp table requests as select id, kind from public.access_requests;
grant select on requests to authenticated;
set local role authenticated;

-- ---------------------------------------------------------------- the admin of another organisation
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d3", "role": "authenticated"}';

select is((select count(*) from public.access_requests), 0::bigint, 'another organisation''s admin does not see the request');
select throws_ok(
  $$ select public.decide_access_request((select id from pg_temp.requests where kind = 'join'), true) $$,
  '42501', null, 'and cannot decide it, even knowing its id'
);

-- ---------------------------------------------------------------- the admin of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d2", "role": "authenticated"}';

select is((select email from public.access_requests), 'newcomer@example.test', 'the admin sees who asks');
select lives_ok(
  $$ select public.decide_access_request((select id from public.access_requests), true, 'viewer') $$,
  'the admin approves, as viewer'
);
select is(
  (select role from public.memberships where user_id = '00000000-0000-0000-0000-0000000000d1'),
  'viewer', 'the newcomer is now a viewer of org one'
);
select throws_ok(
  $$ select public.decide_access_request((select id from public.access_requests), false) $$,
  '55000', null, 'a decided request cannot be decided again'
);

-- ---------------------------------------------------------------- the newcomer, now a member
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

select is((select count(*) from public.organizations), 1::bigint, 'the newcomer reads org one');
select throws_ok(
  $$ select public.request_to_join('50000000-0000-0000-0000-000000000001') $$,
  '23505', null, 'and cannot ask to join it again'
);

-- ---------------------------------------------------------------- a founder asks for a new organisation
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d5", "role": "authenticated"}';

select lives_ok($$ select public.request_organization('  Lamps Inc  ') $$, 'a founder asks for a new organisation');
select throws_ok($$ select public.request_organization('   ') $$, '22023', null, 'a blank name is refused');

reset role;
insert into requests select id, kind from public.access_requests where kind = 'create';
set local role authenticated;

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d2", "role": "authenticated"}';
select throws_ok(
  $$ select public.decide_access_request((select id from pg_temp.requests where kind = 'create'), true) $$,
  '42501', null, 'an organisation admin cannot approve a new organisation'
);

-- ---------------------------------------------------------------- the platform admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d4", "role": "authenticated"}';

select lives_ok(
  $$ select public.decide_access_request((select id from public.access_requests where kind = 'create'), true) $$,
  'a platform admin approves the new organisation'
);
select is(
  (select o.name from public.organizations o join public.memberships m on m.organization_id = o.id
   where m.user_id = '00000000-0000-0000-0000-0000000000d5' and m.role = 'admin'),
  'Lamps Inc', 'the founder is admin of the new organisation, name trimmed'
);

-- ---------------------------------------------------------------- nobody writes the table directly
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d5", "role": "authenticated"}';
select throws_ok(
  $$ update public.access_requests set status = 'approved' $$,
  '42501', null, 'a requester cannot mark a request approved'
);

select * from finish();
rollback;
