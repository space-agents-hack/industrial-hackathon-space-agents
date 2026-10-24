-- Renaming an organisation (#35): its admins and platform admins may, members and outsiders may
-- not, the name is trimmed and bounded, and the rename is audited with both names.
begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin@rename.test'),
  ('00000000-0000-0000-0000-0000000000f2', 'member@rename.test'),
  ('00000000-0000-0000-0000-0000000000f3', 'outsider@rename.test'),
  ('00000000-0000-0000-0000-0000000000f4', 'platform@rename.test');

insert into public.organizations (id, name) values
  ('70000000-0000-0000-0000-000000000001', 'Space agents'),
  ('70000000-0000-0000-0000-000000000002', 'Elsewhere');
insert into public.memberships (organization_id, user_id, role) values
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', 'admin'),
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'member'),
  ('70000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f3', 'admin');
insert into private.platform_admins (user_id, note) values ('00000000-0000-0000-0000-0000000000f4', 'test');

set local role authenticated;

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000f2", "role": "authenticated"}';
select throws_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', 'team-09') $$,
  '42501', null, 'a member cannot rename the organisation'
);

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000f3", "role": "authenticated"}';
select throws_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', 'team-09') $$,
  '42501', null, 'an admin of another organisation cannot rename it'
);

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000f1", "role": "authenticated"}';
select throws_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', '   ') $$,
  '22023', null, 'a blank name is refused'
);
select throws_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', repeat('x', 201)) $$,
  '22023', null, 'a name over 200 characters is refused'
);
select lives_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', '  team-09  ') $$,
  'its admin renames it'
);
select is(
  (select name from public.organizations where id = '70000000-0000-0000-0000-000000000001'),
  'team-09',
  'the name is stored trimmed'
);
select is(
  (select detail from public.audit_events
   where organization_id = '70000000-0000-0000-0000-000000000001' and action = 'organization.renamed'),
  '{"from": "Space agents", "to": "team-09"}'::jsonb,
  'the rename is audited with both names'
);

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000f4", "role": "authenticated"}';
select lives_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000002', 'team-10') $$,
  'a platform admin renames any organisation'
);

reset role;
set local role anon;
select throws_ok(
  $$ select public.rename_organization('70000000-0000-0000-0000-000000000001', 'x') $$,
  '42501', null, 'a signed-out caller cannot call it at all'
);

select * from finish();
rollback;
