import { agentFailure, fail } from "@/lib/admin-route";
import { AgentAdminError, runSubgoalChanges } from "@/lib/agent-admin";
import { parseChangesRequest } from "@/lib/changes";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { readJson } from "@/lib/validation";

// The agent call is given a minute (lib/agent-admin.ts); this leaves room around it.
export const maxDuration = 90;

// Body { organization_id, old_version_id, new_version_id, case_id, team_id, requirements_old? } →
// the sub-goal file and counts. Any member who can read the library may ask: it writes nothing.
// The two versions are read first as the person, so RLS decides whether they may see them; the
// agent, which reads with the secret key, checks again that both belong to that organisation.
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const parsed = parseChangesRequest(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { organizationId, oldVersionId, newVersionId } = parsed.value;

  const { data, error } = await supabase
    .from("regulation_versions")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", [oldVersionId, newVersionId]);
  if (error) {
    console.error("POST /api/changes: reading versions failed", error);
    return fail("The library could not be read.", 502);
  }
  if (data.length !== 2) return fail("One of the versions is not in this organisation's library.", 404);

  try {
    return Response.json(await runSubgoalChanges(parsed.value));
  } catch (agentError) {
    // The agent's refusals here are the person's to fix (two regulations, no requirements loaded
    // for that case), so they keep their status instead of becoming a 502.
    if (agentError instanceof AgentAdminError && [400, 404, 413].includes(agentError.status ?? 0)) {
      return fail(agentError.userMessage, agentError.status ?? 400);
    }
    return agentFailure("POST /api/changes", agentError);
  }
}
