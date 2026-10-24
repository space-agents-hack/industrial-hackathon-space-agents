-- What the Regulations page shows about the search index (#37): per version, its current
-- paragraphs, how many have a key and how many a vector of each model; only to members of the
-- organisation; and the assistant's model is a process an admin can set.
begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin1@example.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'outsider@example.test');

insert into public.organizations (id, name) values
  ('30000000-0000-0000-0000-0000000000e1', 'Org one'),
  ('30000000-0000-0000-0000-0000000000e2', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('30000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1', 'admin'),
  ('30000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e2', 'admin');

set local role service_role;

select public.record_regulation_version('30000000-0000-0000-0000-0000000000e1', null, 'UN R7', 'UN_R7',
  'UN R', 'Position lamps', null, '1.0.0', 'base', null, null, 'r7.pdf', repeat('a', 64), 1000,
  '30000000-0000-0000-0000-0000000000e1/UN_R7/1.0.0/UN_R7_1.0.0.pdf');

create temporary table v as
select id from public.regulation_versions where organization_id = '30000000-0000-0000-0000-0000000000e1';

-- Three current paragraphs, two with the same text (one vector serves both), and one superseded.
insert into public.regulation_paragraphs (version_id, organization_id, position, label, heading, kind,
  text, page_start, page_end, content_hash, superseded_at)
select v.id, '30000000-0000-0000-0000-0000000000e1', x.position, x.label, '5. Specifications',
  'paragraph', x.body, 12, 12, repeat('c', 64), x.gone
from v
join (values
  (1, '5.1', '5.1. Red light.', null::timestamptz),
  (2, '5.2', '5.2. At most 30 cd.', null),
  (3, '5.2', '5.2. At most 30 cd.', null),
  (4, '5.3', '5.3. Old text.', now())
) as x (position, label, body, gone) on true;

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

select is(
  (select row(paragraphs, keyed, vectors)::text
   from public.regulation_index_status('30000000-0000-0000-0000-0000000000e1')),
  row(3::bigint, 0::bigint, '{}'::jsonb)::text,
  'before the indexer: current paragraphs only, no key, no vector');

reset role;
set local role service_role;

select public.refresh_regulation_embedding_keys('30000000-0000-0000-0000-0000000000e1');

-- A vector for "5.2" only, in one model.
insert into public.regulation_embeddings (organization_id, model, input_sha256, embedding)
select distinct '30000000-0000-0000-0000-0000000000e1'::uuid, 'test@1024', k.input_sha256,
  array_fill(0.1::real, array[1024])::extensions.halfvec(1024)
from public.regulation_paragraph_keys k
join public.regulation_paragraphs p on p.id = k.paragraph_id
where p.label = '5.2' and p.superseded_at is null;

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e1", "role": "authenticated"}';

select is(
  (select row(paragraphs, keyed, vectors ->> 'test@1024')::text
   from public.regulation_index_status('30000000-0000-0000-0000-0000000000e1')),
  row(3::bigint, 3::bigint, '2')::text,
  'two of three paragraphs have a vector: the two with the same text share it');

select isnt(
  (select last_embedded_at from public.regulation_index_status('30000000-0000-0000-0000-0000000000e1')),
  null, 'and when it was made');

select is(
  (select count(*) from public.regulation_index_status('30000000-0000-0000-0000-0000000000e1')),
  1::bigint, 'a member reads the status of their library');

select throws_ok($$ select count(*) from public.regulation_embeddings $$, '42501', null,
  'but not the vectors');

select lives_ok(
  $$ select public.set_organization_model('30000000-0000-0000-0000-0000000000e1', 'chat', 'anthropic:claude-haiku-5-5') $$,
  'an admin chooses the assistant''s model');

select is(
  (select model from public.organization_models
   where organization_id = '30000000-0000-0000-0000-0000000000e1' and process = 'chat'),
  'anthropic:claude-haiku-5-5', 'and it is stored as process chat');

select throws_ok(
  $$ select public.set_organization_model('30000000-0000-0000-0000-0000000000e1', 'guessing', 'anthropic:x') $$,
  '23514', null, 'a process outside the list is still refused');

-- ---------------------------------------------------------------- an admin of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000e2", "role": "authenticated"}';

select throws_ok(
  $$ select * from public.regulation_index_status('30000000-0000-0000-0000-0000000000e1') $$,
  '42501', null, 'not another organisation''s');

select * from finish();
rollback;
