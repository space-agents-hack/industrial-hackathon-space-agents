import { agentFailure, fail } from "@/lib/admin-route";
import { askAboutRun } from "@/lib/agent-admin";
import { actsInRunOrganization } from "@/lib/current-org";
import { parseChatRequest } from "@/lib/run-chat";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid, readJson } from "@/lib/validation";

// One answer takes seconds; a model that reads several paragraphs first can take a minute. The
// agent stops at 100 s, the call at 115 s.
export const maxDuration = 120;

// Body { messages: [{ role, content }, ...] }, the question last: the run page's chat (#28,
// SYS-39). The agent reads the run with the secret key and answers with the organisation's model
// and key, so the role is checked here. Admins and members only, as for retrying a run: an answer
// costs model money, and a viewer "changes nothing", spending included.
export async function POST(request: Request, ctx: RouteContext<"/api/runs/[id]/chat">) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const { id } = await ctx.params;
  if (!isUuid(id)) return fail("Unknown run.", 404);

  const messages = parseChatRequest(await readJson(request));
  if (typeof messages === "string") return fail(messages, 400);

  const acts = await actsInRunOrganization(supabase, id);
  if (acts === "missing") return fail("Unknown run.", 404);
  if (acts === "no") return fail("Only admins and members of this organisation can ask about runs.", 403);

  try {
    return Response.json(await askAboutRun(id, messages));
  } catch (error) {
    return agentFailure(`POST /api/runs/${id}/chat`, error);
  }
}
