import { advanceRun, agentFailureStatus, describeAgentFailure } from "@/lib/agent";
import { actsInRunOrganization } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// The run executes while this function holds the connection to the agent (lib/agent.ts).
// 800 s is the ceiling on Vercel Pro, which this project uses (Hobby: 300).
export const maxDuration = 800;

// "Send to agent" and "Resume draft" on the run page: for a run the agent never picked up, or one
// whose last approval was decided but the call that should have resumed it failed.
export async function POST(_request: Request, ctx: RouteContext<"/api/runs/[id]/advance">) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return Response.json({ error: "Unknown run." }, { status: 404 });

  // The agent acts with the secret key and would advance any run it is given, so the role is
  // checked here: readers of the run's organisation may watch it, not push it.
  const acts = await actsInRunOrganization(supabase, id);
  if (acts === "missing") return Response.json({ error: "Unknown run." }, { status: 404 });
  if (acts === "no") {
    return Response.json({ error: "Only admins and members of this organisation can retry runs." }, { status: 403 });
  }

  try {
    await advanceRun(id);
  } catch (agentError) {
    console.error(`POST /api/runs/${id}/advance failed`, agentError);
    return Response.json(
      { error: describeAgentFailure(agentError) },
      { status: agentFailureStatus(agentError) },
    );
  }
  return Response.json({ id });
}
