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

  // Inserted as the user: `created_by` defaults to auth.uid() and RLS rejects anything else.
  const { data: run, error } = await supabase
    .from("runs")
    .insert({ task: parsed.value.task })
    .select("id")
    .single();
  if (error) {
    console.error("POST /api/runs: insert failed", error);
    return Response.json({ error: "The run could not be saved." }, { status: 500 });
  }

  try {
    await advanceRun(run.id);
  } catch (agentError) {
    console.error(`POST /api/runs: run ${run.id} saved but not started`, agentError);
    // The run exists and stays `queued`; the run page offers Retry.
    return Response.json({ id: run.id, warning: describeAgentFailure(agentError) }, { status: 201 });
  }
  return Response.json({ id: run.id }, { status: 201 });
}
