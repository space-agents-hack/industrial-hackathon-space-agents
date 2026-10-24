import { AgentAdminError, storedSubmission } from "@/lib/agent-admin";
import { fetchRun } from "@/lib/runs";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// "Build the file from what is stored" on the run page (#36). A run that never reached `submit`
// has no output, but every window it wrote is stored; the agent turns those rows into the same
// file `submit` would have written.
export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[id]/submission">) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return Response.json({ error: "Unknown run." }, { status: 404 });

  // The agent reads with the secret key, so whether this person may see the run is asked here,
  // as them: RLS hides a run of an organisation they cannot read, and it is then unknown.
  const run = await fetchRun(supabase, id).catch(() => null);
  if (!run) return Response.json({ error: "Unknown run." }, { status: 404 });

  try {
    const { status, submission } = await storedSubmission(id);
    return Response.json({ status, text: JSON.stringify(submission, null, 2) });
  } catch (error) {
    console.error(`GET /api/runs/${id}/submission failed`, error);
    const message = error instanceof AgentAdminError ? error.userMessage : "The agent could not be reached.";
    const status = error instanceof AgentAdminError && error.status === 409 ? 409 : 502;
    return Response.json({ error: message }, { status });
  }
}
