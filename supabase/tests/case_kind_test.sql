-- A case's kind (#42, IF-1): 'main' unless a member creates a sub-goal case, nothing else, and
-- never changed afterwards.
begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'member1@example.test');
insert into public.organizations (id, name) values
  ('50000000-0000-0000-0000-000000000001', 'Org one');
insert into public.memberships (organization_id, user_id, role) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 'member');
insert into public.projects (id, organization_id, name) values
  ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Project');

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

insert into public.cases (id, project_id, organization_id, name) values
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'a product');
select is((select kind from public.cases where id = '52000000-0000-0000-0000-000000000001'), 'main',
  'a case is a main-goal case unless it says otherwise');

insert into public.cases (id, project_id, organization_id, name, kind) values
  ('52000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'subgoal-dev', 'subgoal');
select is((select kind from public.cases where id = '52000000-0000-0000-0000-000000000002'), 'subgoal',
  'a member creates a sub-goal case');

select throws_ok(
  $$ insert into public.cases (project_id, organization_id, name, kind)
     values ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'x', 'other') $$,
  '23514', null, 'no third kind');

select throws_ok(
  $$ update public.cases set kind = 'main' where id = '52000000-0000-0000-0000-000000000002' $$,
  '42501', null, 'the kind is never changed after creation');

reset role;
select is((select count(*) from public.cases where kind = 'subgoal'), 1::bigint,
  'the sub-goal case kept its kind');

select * from finish();
rollback;
