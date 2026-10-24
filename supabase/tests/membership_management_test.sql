-- Managing memberships of existing accounts (SYS-41): an admin gives an account a role in their
-- organisation without creating it, removes people while keeping one active admin, searches only
-- the people they may see, and a platform admin creates an organisation with an existing account
-- as its first admin. One person may belong to several organisations.
begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin1@orgs.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'admin2@orgs.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'member2@orgs.test'),
  ('00000000-0000-0000-0000-0000000000e4', 'loner@orgs.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'platform@orgs.test');

insert into public.organizations (id, name) values
  ('60000000-0000-0000-0000-000000000001', 'Org one'),
  ('60000000-0000-0000-0000-000000000002', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'admin'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000e2', 'admin'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000e3', 'member');
insert into private.platform_admins (user_id, note) values ('00000000-0000-0000-0000-0000000000e5', 'test');

set local role authenticated;

-- ---------------------------------------------------------------- the admin of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

select is(
  (select count(*) from public.find_people('60000000-0000-0000-0000-000000000001', 'orgs.test')),
  1::bigint,
  'an organisation admin finds only people of organisations they manage'
);
select is(
  (select count(*) from public.find_people('60000000-0000-0000-0000-000000000001', 'e')),
  0::bigint,
  'a one-letter search returns nothing'
);
select is(
  (select count(*) from public.find_people('60000000-0000-0000-0000-000000000001', '%')),
  0::bigint,
  'a % is a literal character, not a wildcard'
);
select throws_ok(
  $$ select * from public.find_people('60000000-0000-0000-0000-000000000002', 'orgs.test') $$,
  '42501', null, 'and cannot search on behalf of another organisation'
);

select is(
  public.add_member_by_email('60000000-0000-0000-0000-000000000001', ' Member2@Orgs.test ', 'viewer'),
  '00000000-0000-0000-0000-0000000000e3'::uuid,
  'an admin adds an existing account by email, without a password'
);
select is(
  (select role from public.memberships
   where organization_id = '60000000-0000-0000-0000-000000000001' and user_id = '00000000-0000-0000-0000-0000000000e3'),
  'viewer',
  'with the role chosen'
);
select is(
  (select count(*) from public.audit_events
   where organization_id = '60000000-0000-0000-0000-000000000001' and action = 'member.set'),
  1::bigint,
  'and the change is audited'
);
select is(
  public.add_member_by_email('60000000-0000-0000-0000-000000000001', 'nobody@orgs.test', 'member'),
  null::uuid,
  'an email with no account returns null and adds nobody'
);
select throws_ok(
  $$ select public.add_member_by_email('60000000-0000-0000-0000-000000000001', 'loner@orgs.test', 'owner') $$,
  '22023', null, 'an unknown role is refused'
);
select throws_ok(
  $$ select public.add_member_by_email('60000000-0000-0000-0000-000000000002', 'loner@orgs.test', 'member') $$,
  '42501', null, 'an admin cannot add people to another organisation'
);

select throws_ok(
  $$ select public.remove_member('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1') $$,
  '23514', null, 'the last active admin cannot be removed'
);
select throws_ok(
  $$ select public.remove_member('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000e3') $$,
  '42501', null, 'an admin cannot remove people from another organisation'
);
select throws_ok(
  $$ select public.remove_member('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e4') $$,
  'P0002', null, 'removing someone who is not a member says so'
);
select lives_ok(
  $$ select public.remove_member('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e3') $$,
  'an admin removes a member'
);
select is(
  (select detail ->> 'email' from public.audit_events
   where organization_id = '60000000-0000-0000-0000-000000000001' and action = 'member.removed'),
  'member2@orgs.test',
  'the audit row keeps the email of the person removed'
);
select throws_ok(
  $$ select public.create_organization_with_admin('Org three', 'admin1@orgs.test') $$,
  '42501', null, 'an organisation admin cannot create organisations'
);

-- ---------------------------------------------------------------- the admin of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e2", "role": "authenticated"}';

select is(
  (select count(*) from public.memberships where user_id = '00000000-0000-0000-0000-0000000000e3'),
  1::bigint,
  'the removed person keeps their place in the other organisation'
);

-- ---------------------------------------------------------------- the platform admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e5", "role": "authenticated"}';

select is(
  (select count(*) from public.find_people('60000000-0000-0000-0000-000000000001', 'orgs.test')),
  5::bigint,
  'a platform admin searches every account'
);
select throws_ok(
  $$ select public.create_organization_with_admin('Typo org', 'nobdy@orgs.test') $$,
  'P0002', null, 'an email with no account is refused'
);
select is(
  (select count(*) from public.organizations where name = 'Typo org'),
  0::bigint,
  'and no organisation is left behind'
);

select isnt(
  public.create_organization_with_admin('Org three', 'ADMIN1@orgs.test'),
  null::uuid,
  'a platform admin creates an organisation with an existing account as its first admin'
);
select is(
  (select m.role from public.memberships m join public.organizations o on o.id = m.organization_id
   where o.name = 'Org three' and m.user_id = '00000000-0000-0000-0000-0000000000e1'),
  'admin',
  'that account is its active admin'
);
select lives_ok(
  $$ select public.create_organization_with_admin('Org four', '') $$,
  'with no email the organisation is created with nobody in it'
);

-- ---------------------------------------------------------------- the person made admin there
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

select is(
  jsonb_array_length(public.my_access() -> 'organizations'),
  2,
  'who now belongs to two organisations, with no new account or password'
);

select * from finish();
rollback;
