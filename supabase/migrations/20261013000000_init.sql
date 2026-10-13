-- The contract between the agent service and the web (docs/adr/0001-stack-shape.md).
--
-- Who writes what:
--   web (as the signed-in user)   inserts a run; resolves an approval.
--   agent (secret key, no RLS)    everything else: status, events, approval requests, state.
--
-- Who can see what: every signed-in user sees every run. This fits a team of two to four working
-- on one problem. It is NOT multi-tenant. Who can sign in is controlled by keeping sign-ups off
-- (supabase/README.md), not by these policies.

-- Status values are text with a check, not an enum: adding a value to an enum cannot run inside
-- the same transaction that uses it, which is one more thing to get wrong at 3 a.m.
create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid not null default auth.uid() references auth.users (id),
  task        text not null check (length(task) between 1 and 20000),
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed')),
  -- The model string the run actually used, e.g. "anthropic:claude-opus-5-5". Recorded per run
  -- because AGENT_MODEL can change between two runs that are later compared.
  model       text,
  output      text,
  error       text,
  usage       jsonb not null default '{}'::jsonb
);

-- Append-only log of what the agent did. The web renders it as the trace and never edits it.
create table public.run_events (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references public.runs (id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null
              check (kind in ('status', 'text', 'tool_call', 'tool_result',
                              'approval_requested', 'approval_resolved', 'error')),
  payload     jsonb not null default '{}'::jsonb
);

create index run_events_run_id_id_idx on public.run_events (run_id, id);

-- One row per tool call that needs a person. The agent inserts it as 'pending'; a signed-in user
-- turns it into 'approved' or 'denied' exactly once.
create table public.approvals (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.runs (id) on delete cascade,
  created_at    timestamptz not null default now(),
  tool_call_id  text not null,
  tool_name     text not null,
  args          jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'denied')),
  note          text check (note is null or length(note) <= 2000),
  decided_by    uuid references auth.users (id),
  decided_at    timestamptz,
  unique (run_id, tool_call_id)
);

create index approvals_run_id_idx on public.approvals (run_id);

-- The saved conversation the agent needs to resume a paused run. It holds the full prompt and
-- every tool result, so it is kept out of reach of the browser: RLS is on and there is no policy.
create table public.run_state (
  run_id        uuid primary key references public.runs (id) on delete cascade,
  updated_at    timestamptz not null default now(),
  conversation  jsonb not null
);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger runs_set_updated_at
before update on public.runs
for each row execute function public.set_updated_at();

create trigger run_state_set_updated_at
before update on public.run_state
for each row execute function public.set_updated_at();

-- The decision time comes from the database, not from the browser's clock.
create function public.stamp_approval_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

create trigger approvals_stamp_decision
before update on public.approvals
for each row execute function public.stamp_approval_decision();

alter table public.runs enable row level security;
alter table public.run_events enable row level security;
alter table public.approvals enable row level security;
alter table public.run_state enable row level security;

-- Grants are explicit so the schema behaves the same whether or not the project grants table
-- privileges to the API roles by default.
revoke all on public.runs, public.run_events, public.approvals, public.run_state
  from anon, authenticated;

grant select, insert on public.runs to authenticated;
grant select on public.run_events to authenticated;
grant select on public.approvals to authenticated;
-- Column-level: a user decides; a user cannot rewrite what was asked.
grant update (status, note, decided_by) on public.approvals to authenticated;

grant all on public.runs, public.run_events, public.approvals, public.run_state to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy "signed-in users read runs"
on public.runs for select to authenticated
using (true);

create policy "signed-in users start runs as themselves"
on public.runs for insert to authenticated
with check (created_by = (select auth.uid()) and status = 'queued');

create policy "signed-in users read events"
on public.run_events for select to authenticated
using (true);

create policy "signed-in users read approvals"
on public.approvals for select to authenticated
using (true);

-- `using` limits the row to one that is still pending, so a decision cannot be changed later.
create policy "signed-in users decide pending approvals once"
on public.approvals for update to authenticated
using (status = 'pending')
with check (status in ('approved', 'denied') and decided_by = (select auth.uid()));

-- The trace and the approval card update live. Realtime applies the select policies above.
alter publication supabase_realtime add table public.runs, public.run_events, public.approvals;
