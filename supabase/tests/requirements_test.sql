-- A run's requirements (ADR-0006, #4): everyone in the organisation reads them, only the agent
-- writes them, and a re-extraction of the library neither deletes them nor leaves them pointing
-- at a paragraph whose text changed. If one of these fails, another client reads this one's
-- requirements, a person can rewrite what is submitted, or improving the PDF splitter silently
-- drops every requirement of a regulation.
begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'member2@example.test');

insert into public.organizations (id, name) values
  ('40000000-0000-0000-0000-000000000001', 'Org one'),
  ('40000000-0000-0000-0000-000000000002', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'member'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', 'member');

insert into public.projects (id, organization_id, name) values
  ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Rear lamp'),
  ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'Theirs');
insert into public.cases (id, project_id, organization_id, name) values
  ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001', 'dev-rear-lamp'),
  ('42000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000002',
   '40000000-0000-0000-0000-000000000002', 'theirs');
insert into public.runs (id, organization_id, created_by, task, case_id) values
  ('43000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000c1', 'Write the requirements.',
   '42000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- the library and the agent
set local role service_role;

select public.record_regulation_version('40000000-0000-0000-0000-000000000001', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '00', 'base', null, null, 'UN_R148_base.pdf', repeat('a', 64),
  1000, '40000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf');

create temporary table v on commit drop as
select id from public.regulation_versions where organization_id = '40000000-0000-0000-0000-000000000001';
grant select on v to authenticated;

select public.replace_regulation_paragraphs((select id from v), repeat('a', 64), 'paragraphs-1', 80,
  '[{"position": 0, "label": "5.4.2", "number": "5.4.2", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 12,
     "text": "5.4.2. The rear position lamp shall be visible from the rear.",
     "content_hash": "1111111111111111111111111111111111111111111111111111111111111111"},
    {"position": 1, "label": "5.4.3", "number": "5.4.3", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 13,
     "text": "5.4.3. The intensity shall not exceed 30 cd.",
     "content_hash": "2222222222222222222222222222222222222222222222222222222222222222"}]'::jsonb);

select lives_ok(
  $$ insert into public.requirements (case_id, organization_id, run_id, ext_id, text, version_id,
       paragraph_id, paragraph_hash, regulation, version_label, page, paragraph)
     select '42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
       '43000000-0000-0000-0000-000000000001', 'R-00' || (p.position + 1),
       'The lamp shall meet ' || p.label || '.', p.version_id, p.id, p.content_hash, 'UN R148', '00',
       p.page_start, p.label
     from public.regulation_paragraphs p order by p.position $$,
  'the agent writes a run''s requirements, each citing a paragraph');

select is((select status from public.requirements where ext_id = 'R-001'), 'draft',
  'a requirement starts as a draft');

select throws_ok(
  $$ insert into public.requirements (case_id, organization_id, run_id, ext_id, text, paragraph_hash,
       regulation, version_label, page)
     values ('42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
       '43000000-0000-0000-0000-000000000001', 'R-001', 'Again.', repeat('1', 64), 'UN R148', '00', 12) $$,
  '23505', null, 'an id is used once per run');

select throws_ok(
  $$ insert into public.requirements (case_id, organization_id, run_id, ext_id, text, paragraph_hash,
       regulation, version_label, page)
     values ('42000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
       '43000000-0000-0000-0000-000000000001', 'REQ-9', 'Text.', repeat('1', 64), 'UN R148', '00', 12) $$,
  '23514', null, 'ids follow Certivity''s R-001 format');

select throws_ok(
  $$ insert into public.requirements (case_id, organization_id, run_id, ext_id, text, paragraph_hash,
       regulation, version_label, page)
     values ('42000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
       '43000000-0000-0000-0000-000000000001', 'R-009', 'Text.', repeat('1', 64), 'UN R148', '00', 12) $$,
  '23503', null, 'a requirement cannot sit on another organisation''s case');

-- ---------------------------------------------------------------- a member of org one
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c1", "role": "authenticated"}';

select is((select count(*) from public.requirements), 2::bigint,
  'a member reads their organisation''s requirements');
select throws_ok($$ update public.requirements set text = 'rewritten' $$, '42501', null,
  'a member cannot rewrite a requirement');
select throws_ok($$ update public.requirements set status = 'approved' $$, '42501', null,
  'a member cannot approve one by writing the table');
select throws_ok($$ delete from public.requirements $$, '42501', null,
  'a member cannot delete requirements');
-- ---------------------------------------------------------------- a member of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c2", "role": "authenticated"}';

select is((select count(*) from public.requirements), 0::bigint,
  'another organisation reads none of them');
-- ---------------------------------------------------------------- the library is re-extracted
reset role;
set local role service_role;

-- A better splitter: 5.4.2 comes back word for word, 5.4.3 with different text.
select public.replace_regulation_paragraphs((select id from v), repeat('a', 64), 'paragraphs-2', 80,
  '[{"position": 0, "label": "5.4.2", "number": "5.4.2", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 12,
     "text": "5.4.2. The rear position lamp shall be visible from the rear.",
     "content_hash": "1111111111111111111111111111111111111111111111111111111111111111"},
    {"position": 1, "label": "5.4.3", "number": "5.4.3", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 13,
     "text": "5.4.3. The luminous intensity shall not exceed 30 cd.",
     "content_hash": "3333333333333333333333333333333333333333333333333333333333333333"}]'::jsonb);

select is(
  (select r.paragraph_id = p.id from public.requirements r
   join public.regulation_paragraphs p on p.version_id = r.version_id and p.label = '5.4.2'
     and p.superseded_at is null
   where r.ext_id = 'R-001'),
  true, 'a re-extraction keeps the requirement and links it to the same text again');
select is(
  (select (p.superseded_at is not null, p.text, r.paragraph, r.page)::text
   from public.requirements r join public.regulation_paragraphs p on p.id = r.paragraph_id
   where r.ext_id = 'R-002'),
  '(t,"5.4.3. The intensity shall not exceed 30 cd.",5.4.3,12)',
  'a paragraph whose text changed keeps the link to the superseded text and the citation as written');
select is((select count(*) from public.requirements), 2::bigint,
  'no requirement is lost to a re-extraction');
select is(
  (select string_agg(ext_id, ', ' order by ext_id) from public.requirements
   where paragraph_superseded_at is not null),
  'R-002', 'only the requirement whose paragraph changed is flagged for re-check');

-- An hour later the next import purges what nobody cites, and keeps what R-002 cites.
update public.regulation_paragraphs set superseded_at = now() - interval '2 hours'
where superseded_at is not null;
select public.record_regulation_version('40000000-0000-0000-0000-000000000001', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '00', 'base', null, null, 'UN_R148_base.pdf', repeat('a', 64),
  1000, '40000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf');
select is(
  (select string_agg(p.text, ' | ') from public.regulation_paragraphs p where p.superseded_at is not null),
  '5.4.3. The intensity shall not exceed 30 cd.',
  'the purge keeps a superseded paragraph a requirement cites, and only that one');

-- A different file under the version: both requirements are flagged until a split brings their
-- text back.
select public.record_regulation_version('40000000-0000-0000-0000-000000000001', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '00', 'base', null, null, 'UN_R148_base.pdf', repeat('b', 64),
  1000, '40000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf');
select is((select count(*) from public.requirements where paragraph_superseded_at is not null),
  2::bigint, 'a new file under the version flags every requirement on it');
select public.replace_regulation_paragraphs((select id from v), repeat('b', 64), 'paragraphs-2', 80,
  '[{"position": 0, "label": "5.4.2", "number": "5.4.2", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 12,
     "text": "5.4.2. The rear position lamp shall be visible from the rear.",
     "content_hash": "1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb);
select is(
  (select string_agg(ext_id, ', ' order by ext_id) from public.requirements
   where paragraph_superseded_at is not null),
  'R-002', '... and the split of the new file clears it where the text came back');

select * from finish();
rollback;
