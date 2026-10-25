-- The pictures of the regulation PDFs and their descriptions (#52): everyone in the organisation
-- reads them, nobody but the agent writes them, and a version's pictures are replaced only from
-- the file it still has. If one of these fails, another client reads this one's transcriptions,
-- a member can rewrite what the writer reads as a figure, or the page lists pictures of a PDF
-- that is no longer there.
begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'member1@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'member2@example.test');

insert into public.organizations (id, name) values
  ('10000000-0000-0000-0000-0000000000c1', 'Org one'),
  ('10000000-0000-0000-0000-0000000000c2', 'Org two');
insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 'member'),
  ('10000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c2', 'member');

-- ---------------------------------------------------------------- the agent
set local role service_role;

select public.record_regulation_version('10000000-0000-0000-0000-0000000000c1', null, 'UN R150', 'UN_R150',
  'UN R', null, null, '1.2.1', 'base', null, null, 'UN_R150_base.pdf', repeat('a', 64), 1000,
  '10000000-0000-0000-0000-0000000000c1/UN_R150/1.2.1/UN_R150_1.2.1.pdf');

create temporary table v on commit drop as
select id from public.regulation_versions where organization_id = '10000000-0000-0000-0000-0000000000c1';
grant select on v to authenticated;

select lives_ok(
  $$ insert into public.organization_models (organization_id, process, model)
     values ('10000000-0000-0000-0000-0000000000c1', 'figures', 'anthropic:claude-haiku-5-5') $$,
  'an organisation can choose a model for the figures');

insert into public.regulation_figure_descriptions (organization_id, image_sha256, description, model)
values ('10000000-0000-0000-0000-0000000000c1', repeat('1', 64), 'A lamp 0.2 m above the ground.',
        'anthropic:claude-haiku-5-5');
select throws_ok(
  $$ insert into public.regulation_figure_descriptions (organization_id, image_sha256, model)
     values ('10000000-0000-0000-0000-0000000000c1', repeat('2', 64), 'anthropic:claude-haiku-5-5') $$,
  '23514', null, 'a description row says what the picture shows or why it does not');
select lives_ok(
  $$ insert into public.regulation_figure_descriptions (organization_id, image_sha256, model, error)
     values ('10000000-0000-0000-0000-0000000000c1', repeat('2', 64), 'anthropic:claude-haiku-5-5',
             'BadRequest: image too small') $$,
  'a picture the provider refused keeps the reason');

select is(
  public.replace_regulation_figures((select id from v), repeat('a', 64), 1,
    '[{"page": 3, "position": 0, "image_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
       "width_pt": 200, "height_pt": 120},
      {"page": 3, "position": 1, "image_sha256": "3333333333333333333333333333333333333333333333333333333333333333",
       "width_pt": 80, "height_pt": 80}]'::jsonb),
  2, 'the agent writes a version''s pictures');
select is((select figures_missing from public.regulation_versions where id = (select id from v)), 1,
  '... and how many of them still have no description');

select is(
  public.replace_regulation_figures((select id from v), repeat('a', 64), 0,
    '[{"page": 4, "position": 0, "image_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
       "width_pt": 200, "height_pt": 120}]'::jsonb),
  1, 'splitting again replaces them');
select is((select string_agg(page::text, ',') from public.regulation_figures), '4',
  '... so only the new ones are listed');

select is(
  public.replace_regulation_figures((select id from v), repeat('f', 64), 5, '[]'::jsonb),
  null, 'pictures read from a file the version no longer has are not written');
select is((select (count(*), max(v2.figures_missing))::text
           from public.regulation_figures, public.regulation_versions v2
           where v2.id = (select id from v)),
  '(1,0)', '... and the version keeps what it had');

-- ---------------------------------------------------------------- a member of org one
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c1", "role": "authenticated"}';

select is((select string_agg(d.description, ' | ')
           from public.regulation_figures f
           join public.regulation_figure_descriptions d using (organization_id, image_sha256)),
  'A lamp 0.2 m above the ground.', 'a member reads a version''s pictures with their descriptions');
select throws_ok($$ update public.regulation_figure_descriptions set description = 'rewritten' $$,
  '42501', null, 'a member cannot rewrite a description');
select throws_ok($$ delete from public.regulation_figures $$, '42501', null,
  'a member cannot delete pictures');
select throws_ok(
  $$ select public.replace_regulation_figures((select id from v), repeat('a', 64), 0, '[]'::jsonb) $$,
  '42501', null, 'a signed-in person cannot replace pictures');

-- ---------------------------------------------------------------- a member of org two
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-0000000000c2", "role": "authenticated"}';

select is((select count(*) from public.regulation_figures)
          + (select count(*) from public.regulation_figure_descriptions), 0::bigint,
  'another organisation reads neither');

select * from finish();
rollback;
