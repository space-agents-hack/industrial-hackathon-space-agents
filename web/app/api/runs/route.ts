import { advanceRun, describeAgentFailure } from "@/lib/agent";
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

  // start_run() runs as the user (security invoker): `created_by` defaults to auth.uid(), and RLS
  // accepts the run only if they are an active admin or member of that organisation, and each
  // file only if it was uploaded to that organisation's folder. A viewer, a suspended person or a
  // platform admin who is not a member is refused here, by the database. Run and files are one
  // transaction, so a refused file leaves no run behind.
  const { data: runId, error } = await supabase.rpc("start_run", {
    p_task: parsed.value.task,
    p_organization_id: parsed.value.organizationId,
    p_files: parsed.value.files,
  });
  if (error || !runId) {
    if (error?.code === "42501") {
      return Response.json(
        {
          error: parsed.value.files.length
            ? "The run could not be started: you need the member role here, and every file must have finished uploading."
            : "You cannot start runs in this organisation. Ask one of its admins for the member role.",
        },
        { status: 403 },
      );
    }
    if (error?.code === "22023" || error?.code === "23514" || error?.code === "23505") {
      return Response.json({ error: `The run was refused: ${error.message}` }, { status: 400 });
    }
    console.error("POST /api/runs: start_run failed", error);
    return Response.json({ error: "The run could not be saved." }, { status: 500 });
  }
  return send(runId);
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
  const { data: found } = await supabase.from("cases").select("name").eq("id", caseId).maybeSingle();
  if (!found) return Response.json({ error: "That case does not exist here." }, { status: 404 });
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
        { error: "You cannot start runs on this case. It needs the member role in its organisation." },
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
