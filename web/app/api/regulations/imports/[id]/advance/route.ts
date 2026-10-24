import { fail } from "@/lib/admin-route";
import { advanceRegulationImport, agentFailureStatus, describeAgentFailure } from "@/lib/agent";
import { requireImportManager } from "@/lib/regulation-imports";

// The next slice runs while this function holds the connection to the agent (lib/agent.ts).
// A slice lasts at most about 260 s (import_slice_s in agent/agent_service/settings.py).
export const maxDuration = 300;

// The next slice of an import: called by the import page when the agent left it paused, and by
// its Resume button. The agent claims the import itself, so two open pages cannot both run it.
export async function POST(_request: Request, ctx: RouteContext<"/api/regulations/imports/[id]/advance">) {
  const { id } = await ctx.params;
  const context = await requireImportManager(id);
  if (context instanceof Response) return context;

  try {
    await advanceRegulationImport(id);
  } catch (agentError) {
    console.error(`POST /api/regulations/imports/${id}/advance failed`, agentError);
    return fail(describeAgentFailure(agentError, "import"), agentFailureStatus(agentError));
  }
  return Response.json({ id });
}
