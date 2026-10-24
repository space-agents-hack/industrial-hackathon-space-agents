import { agentFailure, fail } from "@/lib/admin-route";
import { runCertivityChecks } from "@/lib/agent-admin";
import { looksLikeSubmission } from "@/lib/certivity";
import { fetchRun } from "@/lib/runs";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// "Check again" on a part's list of drafts (#51): the checks of a run's stored output, without the
// browser downloading every output first. The agent stores the result with the run, as when the run
// page is opened. A run without output is checked from its page, where its file is built.
export async function POST(_request: Request, ctx: RouteContext<"/api/runs/[id]/checks">) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const { id } = await ctx.params;
  if (!isUuid(id)) return fail("Unknown run.", 404);
  // As the caller: RLS hides a run of an organisation they cannot read.
  const run = await fetchRun(supabase, id).catch(() => null);
  if (!run) return fail("Unknown run.", 404);
  if (!looksLikeSubmission(run.output)) return fail("This draft has no submission file to check.", 409);

  try {
    return Response.json(await runCertivityChecks(run.output, run.organization_id ?? null, null, id));
  } catch (error) {
    return agentFailure(`POST /api/runs/${id}/checks`, error);
  }
}
