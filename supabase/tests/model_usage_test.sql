-- The usage ledger (SYS-40, IF-7, #29): members read their organisation's sums and nobody else's,
-- nobody reads the rows, runs from before the ledger still count, a run is never counted twice,
-- and the monthly cap sums what the page shows.
begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

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

-- Three runs of org one: one from before the ledger, one with ledger rows (and a stale runs.usage
-- that must not be added), one on the scripted model. One run of org two.
insert into public.runs (id, organization_id, created_by, task, status, model, usage) values
  ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'old run', 'succeeded', 'anthropic:claude-opus-5-5',
   '{"input_tokens": 1000, "output_tokens": 100, "requests": 3, "cost_usd": 1.5}'),
  ('22222222-2222-2222-2222-222222222222', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'new run', 'succeeded', 'openai:gpt-test',
   '{"input_tokens": 999999, "output_tokens": 1, "requests": 1, "cost_usd": 999}'),
  ('33333333-3333-3333-3333-333333333333', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'demo', 'succeeded', 'scripted',
   '{"input_tokens": 50, "output_tokens": 5, "requests": 2, "cost_usd": null}'),
  ('44444444-4444-4444-4444-444444444444', '10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-00000000000d', 'other org', 'succeeded', 'openai:gpt-test',
   '{"input_tokens": 10, "output_tokens": 1, "requests": 1, "cost_usd": 100}');

-- What the agent writes, with the secret key.
set local role service_role;

insert into public.model_usage (organization_id, process, provider, model, key_source, key_hint,
                                run_id, requests, input_tokens, output_tokens, cost_usd,
                                unpriced_requests) values
  ('10000000-0000-0000-0000-000000000001', 'writer', 'openai', 'openai:gpt-test', 'organization',
   'wxyz', '22222222-2222-2222-2222-222222222222', 10, 20000, 2000, 0.25, 0),
  ('10000000-0000-0000-0000-000000000001', 'check', 'anthropic', 'anthropic:claude-sonnet-5-5',
   'deployment', 'ANTHROPIC_API_KEY', '22222222-2222-2222-2222-222222222222', 2, 5000, 500, 0.05, 0),
  ('10000000-0000-0000-0000-000000000001', 'embedding', 'openai', 'openai:text-embedding-3-small',
   'organization', 'wxyz', null, 4, 400000, 0, 0.008, 0),
  ('10000000-0000-0000-0000-000000000001', 'transcription', 'ollama', 'ollama:qwen3:32b', 'server',
   'http://gpu:11434', null, 1, 800, 80, 0, 0),
  ('10000000-0000-0000-0000-000000000001', 'summary', 'deepseek', 'deepseek:unknown-model',
   'deployment', 'DEEPSEEK_API_KEY', null, 3, 900, 90, null, 3);

select throws_ok(
  $$ insert into public.model_usage (organization_id, process, provider, model, key_source)
     values ('10000000-0000-0000-0000-000000000001', 'guessing', 'openai', 'openai:x', 'deployment') $$,
  '23514', null, 'a process outside the list is refused');

select is(public.organization_month_cost('10000000-0000-0000-0000-000000000001'), 1.808::numeric,
  'the cap sums the ledger and the old run, not the new run''s own usage or the other org');

reset role;
set local role authenticated;

-- ---------------------------------------------------------------- a viewer of org one
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';

select throws_ok($$ select count(*) from public.model_usage $$, '42501', null,
  'people do not read the rows');
select throws_ok($$ select count(*) from private.usage_entries $$, '42501', null,
  'nor the view behind the sums');
select throws_ok($$ select public.organization_month_cost('10000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'the cap''s sum is the agent''s alone');

select is(
  (select count(*) from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')),
  6::bigint, 'a viewer reads the breakdown: five ledger lines and the old run');

select is(
  (select sum(cost_usd) from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')),
  1.808::numeric, 'the page''s total is the cap''s total');

select is(
  (select row(model, key_source, input_tokens, cost_usd)::text
   from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')
   where key_source = 'unknown'),
  row('anthropic:claude-opus-5-5', 'unknown', 1000::bigint, 1.5::numeric)::text,
  'a run from before the ledger is one line under its model, key unknown');

select is(
  (select count(*) from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')
   where model = 'scripted'),
  0::bigint, 'the scripted model is not usage');

select is(
  (select row(cost_usd, unpriced_requests)::text
   from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')
   where process = 'summary'),
  row(null::numeric, 3::bigint)::text, 'an unpriced model has no cost, and says how many requests');

select is(
  (select cost_usd from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day')
   where provider = 'ollama'),
  0::numeric, 'Ollama is free, not unknown');

select is(
  (select count(distinct provider) from public.organization_usage_series('10000000-0000-0000-0000-000000000001', now() - interval '1 day', 'day')),
  4::bigint, 'the series has one line per provider');

select is(
  (select sum(input_tokens) from public.organization_usage_series('10000000-0000-0000-0000-000000000001', now() - interval '1 day', 'month')),
  427700::numeric, 'the series adds up to the breakdown');

select throws_ok(
  $$ select * from public.organization_usage_series('10000000-0000-0000-0000-000000000001', now(), 'hour') $$,
  '22023', null, 'the series is by day, week or month');

select throws_ok(
  $$ select * from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000002', now() - interval '1 day') $$,
  '42501', null, 'not another organisation''s breakdown');

select throws_ok(
  $$ select * from public.organization_usage_series('10000000-0000-0000-0000-000000000002', now() - interval '1 day') $$,
  '42501', null, 'nor its series');

reset role;
set local role anon;

select throws_ok(
  $$ select * from public.organization_usage_breakdown('10000000-0000-0000-0000-000000000001', now() - interval '1 day') $$,
  '42501', null, 'a visitor reads nothing');

select * from finish();
rollback;
