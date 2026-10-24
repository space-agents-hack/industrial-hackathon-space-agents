import { fail, requireManager } from "@/lib/admin-route";
import { advanceIndex, agentFailureStatus, describeAgentFailure } from "@/lib/agent";
import { isUuid } from "@/lib/validation";

// The agent works for at most index_slice_s (150 s) and this function waits for its answer
// (lib/agent.ts). It has to fit Vercel Hobby's 300 s.
export const maxDuration = 300;

// One slice of indexing the organisation's library (#37): called by the Regulations page after an
// import and by its Index library button, again while the last slice made progress. Admins only,
// as imports: it spends the organisation's embedding and summary keys.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { organization_id?: unknown } | null;
  const org = body?.organization_id;
  if (typeof org !== "string" || !isUuid(org)) return fail("Which organisation?", 400);
  const context = await requireManager(org);
  if (context instanceof Response) return context;

  try {
    return Response.json(await advanceIndex(org));
  } catch (agentError) {
    console.error(`POST /api/regulations/index for ${org} failed`, agentError);
    return fail(describeAgentFailure(agentError, "library"), agentFailureStatus(agentError));
  }
}
