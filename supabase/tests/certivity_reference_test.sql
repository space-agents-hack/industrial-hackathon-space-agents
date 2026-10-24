-- Certivity's answer files: only the agent reads them. If a signed-in person could, the dev
-- case's answer key would be one query away from any browser.
begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

insert into public.certivity_reference (kind, case_id, content, certivity_commit)
values ('expected', 'dev-case', '{"requirements": []}', 'test');

select throws_ok(
  $$ insert into public.certivity_reference (kind, case_id, content, certivity_commit)
     values ('index', 'dev-case', '[]', 'test') $$,
  '23514', null, 'the index belongs to no case');

set local role anon;
select throws_ok($$ select count(*) from public.certivity_reference $$, '42501', null,
  'anon cannot read the reference files');

set local role authenticated;
select throws_ok($$ select count(*) from public.certivity_reference $$, '42501', null,
  'a signed-in user cannot read the reference files');
select throws_ok(
  $$ insert into public.certivity_reference (kind, case_id, content, certivity_commit)
     values ('expected', 'x', '{}', 'x') $$,
  '42501', null, 'a signed-in user cannot write them');

select * from finish();
rollback;
