-- Every model and embedding call an organisation pays for, not only its runs (docs/se SYS-40,
-- issue #29).
--
-- Until now Admin, Usage and the monthly cap read `runs.usage`. That misses case transcription,
-- regulation scope summaries, the regulation vectors, the query vector of every search, and every
-- run that failed (a run that timed out after spending $3 recorded nothing). It also had one number
-- per run, so the check agent's model, which can be another provider's, was folded into the
-- writer's.
--
-- One row per model and key per piece of work: a run segment (start to pause, or to the end), a
-- case ingest, one slice of indexing. Not one row per request: a run makes a few hundred, and the
-- page only ever sums them.
--
-- What this does NOT do: hold the provider's own bill. Costs are the agent's estimate from public
-- price lists (genai-prices) at the time of the call; null means the model has no published price,
-- which is not the same as free. Ollama runs on the organisation's own server and is recorded at $0.

create table public.model_usage (
  id                  bigint generated always as identity primary key,
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  created_at          timestamptz not null default now(),
  -- writer:         the run's own model: the orchestrator and its writers
  -- check:          the check agent (organization_models 'check', else the run's model)
  -- transcription:  case pages a parser cannot read
  -- summary:        the scope summary of each regulation version
  -- embedding:      the regulation vectors, when the library is indexed
  -- search:         the query vector of a search during a run
  -- chat:           questions about a run's results on the run page (#28)
  process             text not null
                      check (process in ('writer', 'check', 'transcription', 'summary', 'embedding',
                                         'search', 'chat')),
  provider            text not null check (length(provider) between 1 and 50),
  -- "provider:model" as the organisation chose it (organization_settings.model,
  -- organization_models), not the dated name the provider answers with: that is the name an admin
  -- recognises, and the one that stays the same between two calls.
  model               text not null check (length(model) between 1 and 200),
  -- organization:  the key connected in Admin, Providers; key_hint is its last 4, as shown there
  -- deployment:    the deployment's environment variable; key_hint is its name, never its value
  -- server:        an Ollama server; key_hint is its URL, as shown in Admin, Providers
  key_source          text not null check (key_source in ('organization', 'deployment', 'server')),
  key_hint            text check (key_hint is null or length(key_hint) <= 200),
  -- Set null, not cascade: deleting a run does not give the money back.
  run_id              uuid references public.runs (id) on delete set null,
  case_id             uuid references public.cases (id) on delete set null,
  requests            integer not null default 0 check (requests >= 0),
  input_tokens        bigint not null default 0 check (input_tokens >= 0),
  output_tokens       bigint not null default 0 check (output_tokens >= 0),
  -- Included in input_tokens, as the providers count them; shown apart because a cached token
  -- costs a tenth of a fresh one on Anthropic.
  cache_read_tokens   bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens  bigint not null default 0 check (cache_write_tokens >= 0),
  -- Ten decimals: one search query is about 10 tokens, $0.0000002 on text-embedding-3-small,
  -- which six decimals would round to nothing however many queries there were.
  cost_usd            numeric(20, 10) check (cost_usd is null or cost_usd >= 0),
  -- Requests the price list did not know. With these above 0 the cost is a lower bound.
  unpriced_requests   integer not null default 0 check (unpriced_requests >= 0)
);

create index model_usage_organization_created_idx on public.model_usage (organization_id, created_at);
create index model_usage_run_idx on public.model_usage (run_id) where run_id is not null;

-- Only the agent writes, with the secret key. People read sums through the functions below, never
-- the rows: a row's key_hint is the same last 4 Admin, Providers shows only to admins.
alter table public.model_usage enable row level security;
revoke all on public.model_usage from anon, authenticated;
grant all on public.model_usage to service_role;

-- The ledger plus the runs recorded before it existed, so the history on the page does not start
-- today. An old run is one line under its writer's model with an unknown key: the split by model
-- and key was never recorded. A run with ledger rows is read from them only, so it is never
-- counted twice; a run paused under the old agent and resumed under the new one loses its first
-- segment, which is the price of not guessing.
create view private.usage_entries as
select u.organization_id, u.created_at, u.process, u.provider, u.model, u.key_source, u.key_hint,
       u.run_id, u.requests, u.input_tokens, u.output_tokens, u.cache_read_tokens,
       u.cache_write_tokens, u.cost_usd, u.unpriced_requests
from public.model_usage u
union all
select r.organization_id, r.created_at, 'writer',
       coalesce(nullif(split_part(r.model, ':', 1), ''), 'unknown'),
       coalesce(r.model, 'unknown'), 'unknown', null::text, r.id,
       coalesce((r.usage ->> 'requests')::integer, 0),
       coalesce((r.usage ->> 'input_tokens')::bigint, 0),
       coalesce((r.usage ->> 'output_tokens')::bigint, 0),
       0::bigint, 0::bigint,
       (r.usage ->> 'cost_usd')::numeric,
       case when r.usage ->> 'cost_usd' is null then 1 else 0 end
from public.runs r
where r.usage <> '{}'::jsonb
  -- The scripted model is a stand-in for tests and demos: no provider, no money.
  and r.model is distinct from 'scripted'
  and not exists (select 1 from public.model_usage u where u.run_id = r.id);

revoke all on private.usage_entries from public, anon, authenticated;

-- Totals by process, provider, model and key since a moment. Every member may read them, as
-- organization_usage before it: what the organisation spends is not a secret inside it.
create function public.organization_usage_breakdown(org uuid, since timestamptz)
returns table (
  process text, provider text, model text, key_source text, key_hint text,
  runs bigint, requests bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, cost_usd numeric, unpriced_requests bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_read(org) then
    raise exception 'not a member of this organisation' using errcode = '42501';
  end if;
  return query
    select e.process, e.provider, e.model, e.key_source, e.key_hint,
           count(distinct e.run_id),
           coalesce(sum(e.requests), 0)::bigint,
           coalesce(sum(e.input_tokens), 0)::bigint,
           coalesce(sum(e.output_tokens), 0)::bigint,
           coalesce(sum(e.cache_read_tokens), 0)::bigint,
           coalesce(sum(e.cache_write_tokens), 0)::bigint,
           -- Null only when nothing in the group had a price.
           sum(e.cost_usd),
           coalesce(sum(e.unpriced_requests), 0)::bigint
    from private.usage_entries e
    where e.organization_id = org and e.created_at >= since
    group by 1, 2, 3, 4, 5
    order by sum(e.cost_usd) desc nulls last, 1, 2, 3;
end;
$$;

-- Tokens and cost per day, week or month (UTC, the same as the monthly cap) and provider, for the
-- chart. Grouped by provider only, not by model: 90 days of five providers is 450 rows, under
-- PostgREST's 1,000-row page, and a model split would not be.
create function public.organization_usage_series(org uuid, since timestamptz, bucket text default 'day')
returns table (period date, provider text, input_tokens bigint, output_tokens bigint, cost_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_read(org) then
    raise exception 'not a member of this organisation' using errcode = '42501';
  end if;
  if bucket not in ('day', 'week', 'month') then
    raise exception 'bucket is day, week or month' using errcode = '22023';
  end if;
  return query
    select date_trunc(bucket, e.created_at at time zone 'utc')::date, e.provider,
           coalesce(sum(e.input_tokens), 0)::bigint,
           coalesce(sum(e.output_tokens), 0)::bigint,
           sum(e.cost_usd)
    from private.usage_entries e
    where e.organization_id = org and e.created_at >= since
    group by 1, 2
    order by 1, 2;
end;
$$;

-- What the monthly cap compares with (agent_service/store.py, month_cost): the same entries as the
-- page, so the page and the cap never disagree on what was spent. Only the agent calls it; it has
-- no person to check, hence no can_read and no grant to authenticated.
create function public.organization_month_cost(org uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.cost_usd), 0)
  from private.usage_entries e
  where e.organization_id = org
    and e.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

revoke all on function public.organization_usage_breakdown(uuid, timestamptz),
  public.organization_usage_series(uuid, timestamptz, text),
  public.organization_month_cost(uuid) from public, anon, authenticated;
grant execute on function public.organization_usage_breakdown(uuid, timestamptz),
  public.organization_usage_series(uuid, timestamptz, text) to authenticated;
grant execute on function public.organization_month_cost(uuid) to service_role;
