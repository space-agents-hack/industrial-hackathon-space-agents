-- Who may record and read changes to the deployment (migration 20261015090000).
begin;
create extension if not exists pgtap with schema extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin1@example.test'),
  ('00000000-0000-0000-0000-00000000000e', 'platform@example.test');
insert into public.organizations (id, name) values ('10000000-0000-0000-0000-000000000001', 'Org one');
insert into public.memberships (organization_id, user_id, role)
values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'admin');
insert into private.platform_admins (user_id, note) values ('00000000-0000-0000-0000-00000000000e', 'test');

set local role authenticated;

-- An organisation's admin is not the deployment's operator.
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok(
  $$ select public.record_deployment_change('deployment.values_saved', '{"names": ["VERCEL_TOKEN"]}') $$,
  '42501', null, 'an organisation admin cannot record deployment changes');

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select lives_ok(
  $$ select public.record_deployment_change('deployment.values_saved', '{"names": ["VERCEL_TOKEN"]}') $$,
  'a platform admin records a deployment change');
select throws_ok(
  $$ select public.record_deployment_change('anything', '{}') $$,
  '22023', null, 'only known changes are recorded');
select is((select count(*) from public.audit_events where organization_id is null), 1::bigint,
  'a platform admin reads deployment changes');

set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is((select count(*) from public.audit_events where organization_id is null), 0::bigint,
  'an organisation admin does not read deployment changes');

select * from finish();
rollback;
