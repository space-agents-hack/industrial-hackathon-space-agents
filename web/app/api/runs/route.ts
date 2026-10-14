import { advanceRun, describeAgentFailure } from "@/lib/agent";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { parseNewRun, readJson } from "@/lib/validation";

// The run executes while this function holds the connection to the agent (lib/agent.ts).
// 300 s is the ceiling on Vercel Hobby; Pro allows 800.
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = parseNewRun(await readJson(request));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // Inserted as the user: `created_by` defaults to auth.uid(), and RLS accepts the row only if
  // they are an active admin or member of that organisation. A viewer, a suspended person or a
  // platform admin who is not a member is refused here, by the database.
  const { data: run, error } = await supabase
    .from("runs")
    .insert({ task: parsed.value.task, organization_id: parsed.value.organizationId })
    .select("id")
    .single();
  if (error) {
    if (error.code === "42501") {
      return Response.json(
        { error: "You cannot start runs in this organisation. Ask one of its admins for the member role." },
        { status: 403 },
      );
    }
    console.error("POST /api/runs: insert failed", error);
    return Response.json({ error: "The run could not be saved." }, { status: 500 });
  }

  try {
    await advanceRun(run.id);
  } catch (agentError) {
    console.error(`POST /api/runs: run ${run.id} saved but not started`, agentError);
    // The run exists and stays `queued`; the run page offers Send to agent.
    return Response.json({ id: run.id, warning: describeAgentFailure(agentError) }, { status: 201 });
  }
  return Response.json({ id: run.id }, { status: 201 });
}
