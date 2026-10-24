-- Each draft's latest Certivity check, kept with the output it checked (SYS-11, IF-4, #51).
--
-- Until now the checks (validate.py, score_local.py, the requirement-level estimate) were computed
-- when a run page was opened and thrown away, so comparing two drafts of a part meant opening both
-- and writing the numbers down. Clemente, 2026-10-24: "save latest checks linked to the output
-- jsons".
--
-- One row per run and source, overwritten on each check: the same output against the same answer
-- key gives the same result, so a history of checks would repeat itself. What does change it (a
-- reloaded answer key, a re-calibrated judge rate) is in the row: certivity_commit, agent_version,
-- and result.requirement_estimate.judge_rate.
--
-- What this does NOT hold: the platform's own scores (those are in the score log,
-- docs/se/verification.md), or the check of a file pasted on the Checks page, which is never
-- stored. And the agent's model never reads it (SYS-42): no tool selects from this table.

create table public.run_checks (
  run_id             uuid not null references public.runs (id) on delete cascade,
  -- output:  runs.output, what `submit` wrote
  -- stored:  the file built from the run's stored requirements, for a run without output (#36).
  --          Kept apart from output so a run that later succeeds keeps both.
  source             text not null check (source in ('output', 'stored')),
  checked_at         timestamptz not null default now(),
  -- Of the exact text that was checked, so a row is known to belong to the output it sits next to.
  submission_sha256  text not null check (submission_sha256 ~ '^[0-9a-f]{64}$'),
  -- Certivity's package the answer keys came from, and the agent build that ran the checks.
  certivity_commit   text not null check (length(certivity_commit) between 1 and 200),
  agent_version      text check (agent_version is null or length(agent_version) <= 100),
  -- certivity.check's answer as the web reads it (lib/certivity.ts parseCheckResult). Stored whole
  -- rather than in columns: the web already parses this shape, and one parser cannot drift from
  -- a second copy of the same fields.
  result             jsonb not null check (jsonb_typeof(result) = 'object'),
  primary key (run_id, source)
);

alter table public.run_checks enable row level security;

-- Only the agent writes, with the secret key: a person could otherwise store any score next to a
-- draft. Reading follows the run, as run_events does.
revoke all on public.run_checks from anon, authenticated;
grant select on public.run_checks to authenticated;
grant all on public.run_checks to service_role;

create policy "people read the checks of runs they can read"
on public.run_checks for select to authenticated
using (exists (select 1 from public.runs r where r.id = run_id));

-- The agent build that last advanced the run (VERCEL_GIT_COMMIT_SHA), so two drafts can be told
-- apart by the code that wrote them, not only by their model. Null for runs from before this
-- column and for local runs. A run resumed after an approval by a newer deployment shows the
-- newer one: the column says who finished it.
alter table public.runs add column agent_version text
  check (agent_version is null or length(agent_version) <= 100);
