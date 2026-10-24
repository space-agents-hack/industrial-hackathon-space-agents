import { agentFailure, fail } from "@/lib/admin-route";
import { assistantModel } from "@/lib/agent-admin";
import { readsProjectOrganization } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// ?project_id=...: the model the assistant answers with in this project, for the panel to name
// before the first question. A model name, never a key.
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const projectId = new URL(request.url).searchParams.get("project_id");
  if (!isUuid(projectId)) return fail("project_id must be a project id.", 400);

  const reads = await readsProjectOrganization(supabase, projectId);
  if (reads === "missing") return fail("Unknown project.", 404);
  if (reads === "no") return fail("You cannot read this project's organisation.", 403);

  try {
    return Response.json({ model: await assistantModel(projectId) });
  } catch (error) {
    return agentFailure("GET /api/chat/model", error);
  }
}
