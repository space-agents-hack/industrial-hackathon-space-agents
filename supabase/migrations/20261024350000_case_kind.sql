-- What a case is for (#42, IF-1): 'main', one product's documents, from which the main goal's
-- requirements are written; or 'subgoal', Certivity's sub-goal folder (requirements written from
-- an old version of a regulation, and the old and new versions), from which the changes file is
-- built. Clemente, 2026-10-24: the sub-goal works like the main goal, in its own section.
--
-- A column and not a guess from the files: "has a requirements_old.json" would make a main case
-- that happens to carry a JSON list a sub-goal case, and the agent would run the wrong engine.
-- Set once, at creation: a case's runs, files and output only make sense for the kind they were
-- made under, so there is no update grant.
--
-- Additive: the default keeps every existing case and every insert by the running web 'main', so
-- this works before and after the new code.

alter table public.cases
  add column kind text not null default 'main' check (kind in ('main', 'subgoal'));

grant insert (kind) on public.cases to authenticated;
