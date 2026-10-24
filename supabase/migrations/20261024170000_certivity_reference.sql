-- Certivity's reference files (docs/se IF-5): what validate.py and score_local.py compare a
-- submission against. One row per file: the list of regulations that may be cited (index), the
-- answer of a worked example (expected, per case) and a sub-goal's old requirements
-- (requirements_old, per case).
--
-- Why a table and not files in git: the files are licensed for the hackathon only and must be
-- deletable afterwards (Certivity's LICENSE-DATA.md, AGENTS.md); a row can be deleted, a commit
-- stays in history. The code that reads them (agent/certivity/tools) stays in git: it is MIT.
--
-- Who writes what:
--   agent (secret key)   reads it for every check; `make certivity-load`
--                        fills it from a clone of Certivity's package.
--   browser, web         nothing. An answer file the browser could read would be a leak.

create table public.certivity_reference (
  kind              text not null check (kind in ('index', 'expected', 'requirements_old')),
  -- '' for the index, which belongs to no case; a case id for the others.
  case_id           text not null default '',
  content           jsonb not null,
  -- The commit of Certivity's package the row was loaded from, shown next to every check.
  certivity_commit  text not null,
  loaded_at         timestamptz not null default now(),
  primary key (kind, case_id),
  check ((kind = 'index') = (case_id = ''))
);

alter table public.certivity_reference enable row level security;

-- No policy, and no grant except to the agent's role: as for run_state.
revoke all on public.certivity_reference from anon, authenticated;
grant all on public.certivity_reference to service_role;
