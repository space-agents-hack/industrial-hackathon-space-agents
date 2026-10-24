-- Search over the regulation library. If one of these fails, either the agent embeds a different
-- text from the one the search looks up (and vector search silently finds nothing), one
-- organisation's search returns another's paragraphs, or a browser reads what only the agent may.
begin;

create extension if not exists pgtap with schema extensions;

select plan(33);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'member1@example.test');

insert into public.organizations (id, name) values
  ('20000000-0000-0000-0000-0000000000b1', 'Org one'),
  ('20000000-0000-0000-0000-0000000000b2', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('20000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'member');

-- A vector pointing along one axis: cosine similarity 1 with itself, 0 with any other axis.
create function pg_temp.axis(i integer) returns extensions.halfvec
language sql immutable as $$
  select (select array_agg(case when g = i then 1 else 0 end order by g)
          from generate_series(1, 1024) g)::real[]::extensions.halfvec(1024)
$$;

set local role service_role;

select lives_ok($$ select public.record_regulation_version('20000000-0000-0000-0000-0000000000b1', null, 'UN R7', 'UN_R7',
  'UN R', 'Position lamps', null, '1.0.0', 'base', null, null, 'r7_base.pdf', repeat('a', 64), 1000,
  '20000000-0000-0000-0000-0000000000b1/UN_R7/1.0.0/UN_R7_1.0.0.pdf') $$,
  'the agent records base in org one');
select lives_ok($$ select public.record_regulation_version('20000000-0000-0000-0000-0000000000b1', null, 'UN R7', 'UN_R7',
  'UN R', null, null, '2.0.0', 'latest', null, null, 'r7_latest.pdf', repeat('b', 64), 1000,
  '20000000-0000-0000-0000-0000000000b1/UN_R7/2.0.0/UN_R7_2.0.0.pdf') $$,
  'the agent records latest in org one');
select lives_ok($$ select public.record_regulation_version('20000000-0000-0000-0000-0000000000b2', null, 'UN R7', 'UN_R7',
  'UN R', 'Position lamps', null, '1.0.0', 'base', null, null, 'r7_base.pdf', repeat('a', 64), 1000,
  '20000000-0000-0000-0000-0000000000b2/UN_R7/1.0.0/UN_R7_1.0.0.pdf') $$,
  'the agent records base in org two');

create temporary table v as
select rv.organization_id as org, rv.version_label as label, rv.id
from public.regulation_versions rv
where rv.organization_id in ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b2');

-- Base and latest of org one share paragraph 5.1 word for word; 5.2 changed. Org two has its own copy
-- of 5.1.
insert into public.regulation_paragraphs (version_id, organization_id, position, label, heading, kind,
  text, page_start, page_end, content_hash)
select v.id, v.org, x.position, x.label, x.heading, 'paragraph', x.body, x.page, x.page, repeat('c', 64)
from v
join (values
  ('1.0.0', 1, '5.1', '5. Specifications', '5.1. The rear position lamp shall emit red light.', 12),
  ('1.0.0', 2, '5.2', '5. Specifications', '5.2. The luminous intensity shall not exceed 30 cd.', 13),
  ('2.0.0', 1, '5.1', '5. Specifications', '5.1. The rear position lamp shall emit red light.', 12),
  ('2.0.0', 2, '5.2', '5. Specifications', '5.2. The luminous intensity shall not exceed 25 cd.', 13)
) as x (label_v, position, label, heading, body, page) on x.label_v = v.label
where v.org = '20000000-0000-0000-0000-0000000000b1';
insert into public.regulation_paragraphs (version_id, organization_id, position, label, heading, kind,
  text, page_start, page_end, content_hash)
select v.id, v.org, 1, '5.1', '5. Specifications', 'paragraph',
  '5.1. The rear position lamp shall emit red light.', 12, 12, repeat('c', 64)
from v where v.org = '20000000-0000-0000-0000-0000000000b2';

-- ---------------------------------------------------------------- what the agent embeds

select is(
  public.regulation_embedding_input('UN R7', 'Position lamps', '5. Specifications', null, '5.1. Red.'),
  E'UN R7 Position lamps\n5. Specifications\n5.1. Red.',
  'the input is the regulation, the headings and the text, one per line, skipping what is missing');

select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'test@1024', 100)),
  0, 'nothing is embedded before the keys are computed');
select is(public.refresh_regulation_embedding_keys('20000000-0000-0000-0000-0000000000b1'),
  4, 'every paragraph of the organisation gets a key');
select is(public.refresh_regulation_embedding_keys('20000000-0000-0000-0000-0000000000b1'),
  0, 'a second refresh changes nothing');
select is(public.refresh_regulation_embedding_keys('20000000-0000-0000-0000-0000000000b2'), 1,
  'another organisation keys its own paragraphs');

select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'test@1024', 100)),
  3, 'a paragraph identical in base and latest is embedded once');

select ok((select bool_and(t.input_sha256 = encode(sha256(convert_to(t.input, 'UTF8')), 'hex'))
           from public.regulation_texts_to_embed('20000000-0000-0000-0000-0000000000b1', 'test@1024', 100) t),
  'the key is the sha256 of exactly the input handed to the agent');

select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'test@1024', 2)),
  2, 'the agent gets the inputs in batches of the size it asks for');

-- The agent's vectors: red light on axis 1, the two intensity limits on axes 2 and 3.
insert into public.regulation_embeddings (organization_id, model, input_sha256, embedding)
select '20000000-0000-0000-0000-0000000000b1', 'test@1024', t.input_sha256,
  pg_temp.axis(case when t.input like '%red light%' then 1 when t.input like '%30 cd%' then 2 else 3 end)
from public.regulation_texts_to_embed('20000000-0000-0000-0000-0000000000b1', 'test@1024', 100) t;

select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'test@1024', 100)),
  0, 'once every input has a vector, nothing is left to embed');
select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'other@1024', 100)),
  3, 'another model starts from nothing: its vectors are not comparable');
select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b2', 'test@1024', 100)),
  1, 'another organisation embeds its own library');

-- ---------------------------------------------------------------- the search

select is((select array_agg(m.label || '@' || m.version_label order by m.label, m.version_label)
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             null, pg_temp.axis(1), 'test@1024', null, 10, 100) m
           where m.similarity > 0.99),
  array['5.1@1.0.0', '5.1@2.0.0'],
  'vectors only: both versions of the paragraph closest to the query come back');

select is((select m.label || '@' || m.version_label
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             null, pg_temp.axis(2), 'test@1024', null, 1, 100) m),
  '5.2@1.0.0', 'vectors only: the nearest paragraph comes first');

select is((select array_agg(m.label order by m.label)
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'luminous intensity of the lamp', null, 'test@1024',
             array[(select id from v where org = '20000000-0000-0000-0000-0000000000b1' and label = '1.0.0')],
             10, 100) m),
  array['5.1', '5.2'],
  'full text only: any word of the query matches, limited to the chosen version');

select is((select m.label
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'luminous intensity of the lamp', null, 'test@1024',
             array[(select id from v where org = '20000000-0000-0000-0000-0000000000b1' and label = '1.0.0')],
             1, 100) m),
  '5.2', 'full text only: the paragraph with more of the query''s words ranks first');

select is((select m.text_rank is not null and m.vector_rank is not null
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'red light', pg_temp.axis(1), 'test@1024',
             array[(select id from v where org = '20000000-0000-0000-0000-0000000000b1' and label = '1.0.0')],
             1, 100) m),
  true, 'both: a paragraph found by both halves ranks first and says so');

select is((select m.page_start
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'red light', pg_temp.axis(1), 'test@1024', null, 1, 100) m),
  12, 'a result carries the page that a submission cites');

select is((select count(*)::integer
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'red light', pg_temp.axis(1), 'other@1024', null, 10, 100) m
           where m.vector_rank is not null),
  0, 'a query is never compared with vectors of another model');

select is((select count(*)::integer
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b2',
             'red light lamp', pg_temp.axis(1), 'test@1024', null, 10, 100) m
           where m.vector_rank is not null),
  0, 'another organisation''s vectors are not used for this one');

select is((select count(*)::integer
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b2',
             'red light lamp', pg_temp.axis(1), 'test@1024',
             array(select id from v where org = '20000000-0000-0000-0000-0000000000b1'), 10, 100) m),
  0, 'version ids of another organisation find nothing');

select is((select count(*)::integer
           from public.match_regulation_paragraphs('20000000-0000-0000-0000-0000000000b1',
             'the of and', null, 'test@1024', null, 10, 100) m),
  0, 'a query of stop words alone finds nothing instead of failing');

-- ---------------------------------------------------------------- pruning

update public.regulation_paragraphs set text = '5.2. The luminous intensity shall not exceed 20 cd.'
where organization_id = '20000000-0000-0000-0000-0000000000b1' and text like '%25 cd%';

select is((select m.vector_rank from public.match_regulation_paragraphs(
    '20000000-0000-0000-0000-0000000000b1', null, pg_temp.axis(3), 'test@1024', null, 1, 100) m),
  1, 'until the keys are refreshed, a changed paragraph keeps its old vector');
select is(public.refresh_regulation_embedding_keys('20000000-0000-0000-0000-0000000000b1'),
  1, 'the refresh finds the one changed paragraph');
select is(public.prune_regulation_embeddings('20000000-0000-0000-0000-0000000000b1', 'test@1024'),
  1, 'the vector of a text that no paragraph has any more is deleted');
select is((select count(*)::integer from public.regulation_texts_to_embed(
    '20000000-0000-0000-0000-0000000000b1', 'test@1024', 100)),
  1, 'and the changed text is the only one left to embed');

select lives_ok($$ select public.analyze_regulation_search() $$,
  'the agent refreshes the planner statistics of the search tables');

-- ---------------------------------------------------------------- what a browser can do

update public.regulation_versions set scope_summary = 'Front and rear position lamps.',
  scope_keywords = array['rear position lamp'], summary_model = 'test', summary_sha256 = repeat('a', 64)
where organization_id = '20000000-0000-0000-0000-0000000000b1' and version_label = '1.0.0';

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';

select is((select scope_summary from public.regulation_versions where version_label = '1.0.0'),
  'Front and rear position lamps.', 'a member reads the scope summaries of their library');
select throws_ok($$ select count(*) from public.regulation_embeddings $$, '42501', null,
  'a browser cannot read the vectors');
select throws_ok($$ select count(*) from public.match_regulation_paragraphs(
    '20000000-0000-0000-0000-0000000000b1', 'red', null, 'test@1024') $$, '42501', null,
  'a browser cannot run the search: the query has to be embedded by the agent');

select throws_ok($$ select public.analyze_regulation_search() $$, '42501', null,
  'a browser cannot run ANALYZE through the agent''s function');

select * from finish();
rollback;
