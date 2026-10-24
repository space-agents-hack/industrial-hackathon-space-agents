-- An Ollama server (SYS-30, #21): its URL and user name are visible to members, its token or
-- password is not, and only the agent reads it back.
begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin1@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'member1@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Org one');

insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'admin'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'member');

set local role authenticated;

-- ---------------------------------------------------------------- the admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select lives_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'http://localhost:11434', 'none') $$,
  'an admin connects an Ollama server with no authentication');

select is(
  (select row(base_url, auth_scheme, auth_username, last4)::text from public.provider_connections
   where provider = 'ollama'),
  row('http://localhost:11434', 'none', null::text, '')::text,
  'members see the URL and the scheme');

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'http://admin:hunter2@ollama.internal:11434', 'none') $$,
  '22023', null, 'a URL carrying a password is refused');

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'file:///etc/passwd', 'none') $$,
  '22023', null, 'only http and https');

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'openai',
       'https://api.openai.com', 'none') $$,
  '22023', null, 'a hosted provider is not configured with a URL');

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'https://ollama.example.test', 'bearer') $$,
  '22023', null, 'bearer without a token is refused');

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'https://ollama.example.test', 'basic', null, 'a-password-123') $$,
  '22023', null, 'basic without a user name is refused');

select lives_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'https://ollama.example.test/proxy', 'bearer', null, 'tok-0123456789wxyz') $$,
  'an admin switches to a bearer token behind a proxy');

select is((select last4 from public.provider_connections where provider = 'ollama'), 'wxyz',
  'a token shows its last four characters, like a key');

select lives_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'https://ollama.example.test:8443/proxy', 'bearer') $$,
  'changing the port keeps the stored token');

select lives_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'https://ollama.example.test', 'basic', 'engineer', 'pass-word-42') $$,
  'an admin switches to basic authentication');

select is(
  (select row(auth_scheme, auth_username, last4)::text from public.provider_connections
   where provider = 'ollama'),
  row('basic', 'engineer', '')::text,
  'basic shows the user name and nothing of the password');

select throws_ok(
  $$ select secret_id from public.provider_connections $$, '42501', null,
  'the Vault handle is still not readable');

select throws_ok(
  $$ select public.read_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama') $$,
  '42501', null, 'a signed-in user cannot read the password back');

select ok(not exists (select 1 from public.audit_events
                      where detail::text like '%pass-word%' or detail::text like '%0123456789%'),
  'the audit log holds neither the token nor the password');

select is((select count(*) from public.audit_events where detail->>'provider' = 'ollama'), 4::bigint,
  'each change is audited');

-- ---------------------------------------------------------------- a member
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';

select throws_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'http://localhost:11434', 'none') $$,
  '42501', null, 'a member cannot change the server');

select is((select base_url from public.provider_connections where provider = 'ollama'),
  'https://ollama.example.test', 'a member sees which server is used');

-- ---------------------------------------------------------------- the agent
reset role;
set local role service_role;

select is(
  public.read_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama'),
  '{"base_url": "https://ollama.example.test", "auth_scheme": "basic", "username": "engineer", "secret": "pass-word-42"}'::jsonb,
  'the agent reads the address and the password');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';

select lives_ok(
  $$ select public.set_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama',
       'http://localhost:11434', 'none') $$,
  'back to no authentication');

reset role;

select is((select count(*) from vault.secrets
           where name = 'provider:10000000-0000-0000-0000-000000000001:ollama'), 0::bigint,
  'dropping authentication deletes the password from Vault');

select is(public.read_provider_endpoint('10000000-0000-0000-0000-000000000001', 'ollama'),
  '{"base_url": "http://localhost:11434", "auth_scheme": "none", "username": null, "secret": null}'::jsonb,
  'with no authentication the agent gets the address alone');

select * from finish();
rollback;
