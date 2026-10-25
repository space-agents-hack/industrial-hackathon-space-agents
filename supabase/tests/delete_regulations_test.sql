-- Deleting regulations from a library (SYS-46, #56): only that organisation's admins, never
-- during an import, and a run's requirements survive it with their citation text. If one of these
-- fails, a member wipes the library everyone cites, another client's library goes, or deleting a
-- regulation silently removes requirements a person already approved.
begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- What the Storage API sets before its own delete, so the policy is what decides here, as it does
-- for the web's remove() call.
set local storage.allow_delete_query to 'true';

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin1@example.test'),
  ('00000000-0000-0000-0000-0000000000d2', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000d3', 'admin2@example.test');

insert into public.organizations (id, name) values
  ('50000000-0000-0000-0000-000000000001', 'Org one'),
  ('50000000-0000-0000-0000-000000000002', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 'admin'),
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 'member'),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000d3', 'admin');

insert into public.projects (id, organization_id, name, all_regulations) values
  ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Rear lamp', false);
insert into public.cases (id, project_id, organization_id, name) values
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001', 'a part');
insert into public.runs (id, organization_id, created_by, task, case_id) values
  ('53000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000d2', 'Write the requirements.',
   '52000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- two libraries, as the agent fills them
set local role service_role;

select public.record_regulation_version('50000000-0000-0000-0000-000000000001', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '00', 'base', null, null, 'UN_R148_base.pdf', repeat('a', 64),
  1000, '50000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf');
select public.record_regulation_version('50000000-0000-0000-0000-000000000001', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '01', 'latest', null, null, 'UN_R148_latest.pdf', repeat('b', 64),
  1000, '50000000-0000-0000-0000-000000000001/UN_R148/01/UN_R148_01.pdf');
select public.record_regulation_version('50000000-0000-0000-0000-000000000001', null, 'UN R10',
  'UN_R10', 'UN R', null, null, '06', 'base', null, null, 'UN_R10_base.pdf', repeat('c', 64),
  1000, '50000000-0000-0000-0000-000000000001/UN_R10/06/UN_R10_06.pdf');
select public.record_regulation_version('50000000-0000-0000-0000-000000000002', null, 'UN R148',
  'UN_R148', 'UN R', null, null, '00', 'base', null, null, 'UN_R148_base.pdf', repeat('a', 64),
  1000, '50000000-0000-0000-0000-000000000002/UN_R148/00/UN_R148_00.pdf');

create temporary table r148 on commit drop as
select id from public.regulations
where organization_id = '50000000-0000-0000-0000-000000000001' and code = 'UN R148';
grant select on r148 to authenticated;

select public.replace_regulation_paragraphs(
  (select v.id from public.regulation_versions v join r148 on r148.id = v.regulation_id
   where v.version_label = '00'),
  repeat('a', 64), 'paragraphs-1', 80,
  '[{"position": 0, "label": "5.4.2", "number": "5.4.2", "kind": "paragraph",
     "heading": "5. General specifications", "page_start": 12, "page_end": 12,
     "text": "5.4.2. The rear position lamp shall be visible from the rear.",
     "content_hash": "1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb);

insert into public.requirements (case_id, organization_id, run_id, ext_id, text, version_id,
  paragraph_id, paragraph_hash, regulation, version_label, page, paragraph, status)
select '52000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
  '53000000-0000-0000-0000-000000000001', 'R-001', 'The lamp shall be visible from the rear.',
  p.version_id, p.id, p.content_hash, 'UN R148', '00', p.page_start, p.label, 'approved'
from public.regulation_paragraphs p;

insert into public.project_regulations (project_id, regulation_id, organization_id)
select '51000000-0000-0000-0000-000000000001', id, '50000000-0000-0000-0000-000000000001' from r148;

insert into storage.objects (bucket_id, name) values
  ('regulations', '50000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf'),
  ('regulations', '50000000-0000-0000-0000-000000000002/UN_R148/00/UN_R148_00.pdf');

reset role;

-- ---------------------------------------------------------------- a member
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d2", "role": "authenticated"}';

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000001', array(select id from r148)) $$,
  '42501', null, 'a member cannot delete regulations');

select results_eq(
  $$ select requirements from public.regulation_citation_counts('50000000-0000-0000-0000-000000000001') $$,
  array[1], 'a member reads how many requirements cite each regulation');

select is((select count(*) from storage.objects
           where bucket_id = 'regulations' and name like '50000000-0000-0000-0000-000000000001/%'),
  1::bigint, 'a member reads the PDFs');
delete from storage.objects
where bucket_id = 'regulations' and name like '50000000-0000-0000-0000-000000000001/%';
reset role;
select is((select count(*) from storage.objects
           where bucket_id = 'regulations' and name like '50000000-0000-0000-0000-000000000001/%'),
  1::bigint, 'but cannot delete them');

-- ---------------------------------------------------------------- another organisation's admin
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d3", "role": "authenticated"}';

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000001', array(select id from r148)) $$,
  '42501', null, 'an admin of another organisation cannot delete this library');

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000002', array(select id from r148)) $$,
  'P0002', null, 'nor reach it by naming their own organisation');

select is_empty(
  $$ select * from public.regulation_citation_counts('50000000-0000-0000-0000-000000000001') $$,
  'nor count its citations');

-- ---------------------------------------------------------------- the admin
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000001', array[]::uuid[]) $$,
  '22023', null, 'an empty choice is refused');

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000001',
       array(select gen_random_uuid() from generate_series(1, 26))) $$,
  '22023', null, 'more than one batch is refused');

select public.create_regulation_import('50000000-0000-0000-0000-000000000001', 'index.json',
  '[{"regulation": "UN R148"}]'::jsonb);

select throws_ok(
  $$ select public.delete_regulations('50000000-0000-0000-0000-000000000001', array(select id from r148)) $$,
  '55000', null, 'nothing is deleted while an import is in progress');

reset role;
update public.regulation_imports set status = 'succeeded', finished_at = now()
where organization_id = '50000000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000d1", "role": "authenticated"}';

create temporary table outcome on commit drop as
select public.delete_regulations('50000000-0000-0000-0000-000000000001', array(select id from r148)) as o;

select is((select o - 'paths' from outcome),
  '{"regulations": 1, "versions": 2, "paragraphs": 1, "requirements_unlinked": 1}'::jsonb,
  'the admin deletes the regulation and is told what went with it');

select is((select o -> 'paths' from outcome),
  '["50000000-0000-0000-0000-000000000001/UN_R148/00/UN_R148_00.pdf",
    "50000000-0000-0000-0000-000000000001/UN_R148/01/UN_R148_01.pdf"]'::jsonb,
  'with the PDFs for the web to remove');

delete from storage.objects
where bucket_id = 'regulations' and name like '50000000-0000-0000-0000-000000000001/%';

reset role;

select is((select count(*) from storage.objects
           where bucket_id = 'regulations' and name like '50000000-0000-0000-0000-000000000001/%'),
  0::bigint, 'the admin removes the PDFs');
select is((select count(*) from public.regulations where id in (select id from r148)), 0::bigint,
  'the regulation is gone');
select is((select count(*) from public.regulation_versions v
           join public.regulations r on r.id = v.regulation_id
           where r.organization_id = '50000000-0000-0000-0000-000000000001'), 1::bigint,
  'with its versions, and only its versions');
select is((select count(*) from public.regulation_paragraphs
           where organization_id = '50000000-0000-0000-0000-000000000001'), 0::bigint,
  'and its paragraphs');
select is((select count(*) from public.project_regulations), 0::bigint,
  'and the projects'' choice of it');

select is((select status from public.requirements where ext_id = 'R-001'), 'approved',
  'the requirement a person approved is still there');
select is((select regulation || ' ' || version_label || ' p' || page || ' ' || paragraph
           from public.requirements where ext_id = 'R-001'),
  'UN R148 00 p12 5.4.2', 'with the citation it was written with');
select is((select (version_id is null and paragraph_id is null) from public.requirements
           where ext_id = 'R-001'),
  true, 'and no link to a paragraph that no longer exists');

select is((select count(*) from public.regulations
           where organization_id = '50000000-0000-0000-0000-000000000002'), 1::bigint,
  'another organisation''s library is untouched');

select is((select detail -> 'codes' from public.audit_events
           where action = 'regulations.deleted'
             and organization_id = '50000000-0000-0000-0000-000000000001'),
  '["UN R148"]'::jsonb, 'the deletion is in the audit log');

select * from finish();
rollback;
