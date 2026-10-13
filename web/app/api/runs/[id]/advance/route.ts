import { advanceRun, agentFailureStatus, describeAgentFailure } from "@/lib/agent";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// The run executes while this function holds the connection to the agent (lib/agent.ts).
// 300 s is the ceiling on Vercel Hobby; Pro allows 800.
export const maxDuration = 300;

// "Retry": for a run the agent never picked up, or one whose last approval was decided but the
// call that should have resumed it failed.
export async function POST(_request: Request, ctx: RouteContext<"/api/runs/[id]/advance">) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return Response.json({ error: "Unknown run." }, { status: 404 });

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
