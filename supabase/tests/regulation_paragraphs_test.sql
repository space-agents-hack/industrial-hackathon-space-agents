-- The paragraphs of the regulation library: everyone in the organisation reads them, nobody but
-- the agent writes them, they are replaced all at once, and they go when the file under a version
-- changes. If one of these fails, either another client reads this one's library, someone can
-- rewrite the text every answer cites, or answers cite pages of a PDF that is no longer there.
begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'member2@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-0000000000b1', 'Org one'),
  ('10000000-0000-0000-0000-0000000000b2', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'member'),
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'member');

-- ---------------------------------------------------------------- the agent splits a version
set local role service_role;

select public.record_regulation_version('10000000-0000-0000-0000-0000000000b1', null, 'UN R150', 'UN_R150',
  'UN R', null, null, '1.2.1', 'base', null, null, 'UN_R150_base.pdf', repeat('a', 64), 1000,
  '10000000-0000-0000-0000-0000000000b1/UN_R150/1.2.1/UN_R150_1.2.1.pdf');

create temporary table v on commit drop as
select id from public.regulation_versions where organization_id = '10000000-0000-0000-0000-0000000000b1';
grant select on v to authenticated;

select is(
  public.replace_regulation_paragraphs((select id from v), repeat('a', 64), 'paragraphs-1', 54,
    '[{"position": 0, "label": "5.1.4.4.1", "number": "5.1.4.4.1", "kind": "paragraph",
       "heading": "5. Specific technical requirements", "page_start": 12, "page_end": 13,
       "text": "5.1.4.4.1. The RI values for red retro-reflectors must be equal to or greater than those in Table 3.",
       "content_hash": "1111111111111111111111111111111111111111111111111111111111111111"},
      {"position": 1, "label": "Annex 6 Part 1 3", "annex": "6", "part": "1", "number": "3",
       "kind": "paragraph", "heading": "Annex 6 Environmental Testing > Part 1 - Resistance to heat",
       "page_start": 42, "page_end": 42,
       "text": "3. After this test, no cracking or appreciable distortion must be visible.",
       "content_hash": "2222222222222222222222222222222222222222222222222222222222222222"}]'::jsonb),
  2, 'the agent writes a version''s paragraphs');

select is((select (page_count, paragraph_count, extracted_with, extraction_error)::text
           from public.regulation_versions where id = (select id from v)),
  '(54,2,paragraphs-1,)', 'the version records what was extracted and by which extractor');

select is(
  public.replace_regulation_paragraphs((select id from v), repeat('a', 64), 'paragraphs-2', 54,
    '[{"position": 0, "label": "Annex 6 Part 1 3", "annex": "6", "part": "1", "number": "3",
       "kind": "paragraph", "heading": "Annex 6 Environmental Testing", "page_start": 42,
       "page_end": 42, "text": "3. After this test, no cracking must be visible.",
       "content_hash": "3333333333333333333333333333333333333333333333333333333333333333"}]'::jsonb),
  1, 'splitting again replaces the paragraphs');
select is((select count(*) from public.regulation_paragraphs where version_id = (select id from v)),
  1::bigint, 'no paragraph of the earlier split is left');

select is(
  public.replace_regulation_paragraphs((select id from v), repeat('f', 64), 'paragraphs-2', 54, '[]'::jsonb),
  null, 'paragraphs split from a file the version no longer has are not written');
select is((select count(*) from public.regulation_paragraphs where version_id = (select id from v)),
  1::bigint, '... and the current ones stay');

select is((select label from public.regulation_paragraphs
           where fts @@ websearch_to_tsquery('english', 'cracking visible')),
  'Annex 6 Part 1 3', 'full-text search finds a paragraph by its words, stemmed');
select is((select label from public.regulation_paragraphs
           where fts @@ websearch_to_tsquery('english', 'environmental testing')),
  'Annex 6 Part 1 3', 'and by the titles above it');

-- ---------------------------------------------------------------- a member of org one
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';

select is((select count(*) from public.regulation_paragraphs), 1::bigint,
  'a member reads their organisation''s paragraphs');
select throws_ok($$ update public.regulation_paragraphs set text = 'rewritten' $$, '42501', null,
  'a member cannot rewrite a paragraph');
select throws_ok($$ delete from public.regulation_paragraphs $$, '42501', null,
  'a member cannot delete paragraphs');
select throws_ok(
  $$ select public.replace_regulation_paragraphs((select id from v), repeat('a', 64), 'x', 1, '[]'::jsonb) $$,
  '42501', null, 'a signed-in person cannot replace paragraphs');
select throws_ok(
  $$ select public.record_regulation_extraction_failure((select id from v), repeat('a', 64), 'x', 'no') $$,
  '42501', null, 'a signed-in person cannot mark a version as failed');

-- ---------------------------------------------------------------- a member of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000b2", "role": "authenticated"}';

select is((select count(*) from public.regulation_paragraphs), 0::bigint,
  'another organisation does not read them');

-- ---------------------------------------------------------------- the file changes
reset role;
set local role service_role;

select public.record_regulation_version('10000000-0000-0000-0000-0000000000b1', null, 'UN R150', 'UN_R150',
  'UN R', null, null, '1.2.1', 'base', null, null, 'UN_R150_base.pdf', repeat('b', 64), 1000,
  '10000000-0000-0000-0000-0000000000b1/UN_R150/1.2.1/UN_R150_1.2.1.pdf');

select is((select count(*) from public.regulation_paragraphs where version_id = (select id from v)),
  0::bigint, 'a different file under the same version drops its paragraphs');
select is((select (paragraph_count, extracted_with)::text from public.regulation_versions
           where id = (select id from v)),
  '(,)', '... and marks the version as not split, so the next import splits it');

select public.record_regulation_extraction_failure((select id from v), repeat('b', 64), 'paragraphs-2',
  'No text layer.');
select is((select extraction_error from public.regulation_versions where id = (select id from v)),
  'No text layer.', 'a file that cannot be split records why');

select * from finish();
rollback;
