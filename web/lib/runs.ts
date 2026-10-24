import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { type ApprovalRow, type RunEventRow, type RunRow, type RunSummary, summarizeRun } from "@/lib/trace";

// The reads behind both pages. They take a client instead of creating one so the same code runs
// on the server (first render) and in the browser (refetch after subscribing to Realtime).
type Client = SupabaseClient<Database>;

export const RUN_LIST_LIMIT = 50;

// PostgREST returns at most this many rows per request (`max_rows` in supabase/config.toml and
// the hosted default).
const PAGE_SIZE = 1000;

// One organisation's runs. RLS would also return the runs of every other organisation the person
// can read (all of them, for a platform admin), so the filter is what scopes the list.
export async function fetchRunList(supabase: Client, organizationId: string): Promise<RunSummary[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("id, created_at, status, model, task, cases(name, projects(name))")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(RUN_LIST_LIMIT);
  if (error) throw error;
  return data.map((run) => ({
    ...summarizeRun(run),
    where: run.cases ? `${run.cases.projects?.name ?? "Project"} › ${run.cases.name}` : undefined,
  }));
}

export async function fetchRun(supabase: Client, runId: string): Promise<RunRow | null> {
  const { data, error } = await supabase.from("runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchRunEvents(supabase: Client, runId: string): Promise<RunEventRow[]> {
  const events: RunEventRow[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("run_events")
      .select("*")
      .eq("run_id", runId)
      .gt("id", events.at(-1)?.id ?? 0)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    events.push(...data);
    if (data.length < PAGE_SIZE) return events;
  }
}

export async function fetchApprovals(supabase: Client, runId: string): Promise<ApprovalRow[]> {
  const { data, error } = await supabase
    .from("approvals")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}
