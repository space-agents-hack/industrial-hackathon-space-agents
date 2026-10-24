import { advanceRun, describeAgentFailure } from "@/lib/agent";
import { fetchReadiness, runBlockers } from "@/lib/run-readiness";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { parseNewRun, readJson } from "@/lib/validation";

// The run executes while this function holds the connection to the agent (lib/agent.ts).
// 800 s is the ceiling on Vercel Pro, which this project uses (Hobby: 300).
export const maxDuration = 800;

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = parseNewRun(await readJson(request));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  if (parsed.value.caseId) {
    const { organizationId, caseId, task, model } = parsed.value;
    return startOnCase(supabase, organizationId, caseId, task, model);
  }
  // Every run is on a case now (Clemente, 2026-10-24): the app only starts runs on a case, and a
  // run without one belongs to no project and cannot be scoped to its regulations.
  return Response.json({ error: "A draft needs a part: create one in a project and add its files." }, { status: 400 });
}

// A run on a case (ADR-0006) is a plain insert as the user: the case's files are already in
// case_files and parsed, and the composite key (case_id, organization_id) refuses a case from
// another organisation.
async function startOnCase(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  caseId: string,
  task: string,
  model: string | null,
) {
  const [{ data: found }, readiness] = await Promise.all([
    supabase.from("cases").select("name").eq("id", caseId).maybeSingle(),
    fetchReadiness(supabase, caseId),
  ]);
  if (!found || !readiness) return Response.json({ error: "That part does not exist here." }, { status: 404 });
  const blockers = runBlockers(readiness);
  if (blockers.length > 0) return Response.json({ error: blockers.join(" ") }, { status: 409 });
  const { data, error } = await supabase
    .from("runs")
    .insert({
      task: task || `Case: ${found.name}`,
      organization_id: organizationId,
      case_id: caseId,
      requested_model: model,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "42501" || error?.code === "23503") {
      return Response.json(
        { error: "You cannot draft requirements for this part. It needs the member role in its organisation." },
        { status: 403 },
      );
    }
    console.error("POST /api/runs: run on case failed", error);
    return Response.json({ error: "The run could not be saved." }, { status: 500 });
  }
  return send(data.id);
}

async function send(runId: string) {
  const run = { id: runId };
  try {
    await advanceRun(run.id);
  } catch (agentError) {
    console.error(`POST /api/runs: run ${run.id} saved but not started`, agentError);
    // The run exists and stays `queued`; the run page offers Send to agent.
    return Response.json({ id: run.id, warning: describeAgentFailure(agentError) }, { status: 201 });
  }
  return Response.json({ id: run.id }, { status: 201 });
}
