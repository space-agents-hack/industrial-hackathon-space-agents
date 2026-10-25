import { agentFailure, fail } from "@/lib/admin-route";
import { askAssistant } from "@/lib/agent-admin";
import { parseChatRequest } from "@/lib/assistant";
import { READ_ONLY_ASSISTANT, readsProjectOrganization } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { readJson } from "@/lib/validation";

// One answer takes seconds; a model that reads several paragraphs first can take a minute. The
// agent stops at 100 s, the call at 115 s.
export const maxDuration = 120;

// Body { project_id, path, messages: [{ role, content }, ...] }, the question last: the assistant
// on every page of a project (SYS-39, #31). The agent reads the project with the secret key and
// answers with the organisation's model and key, so access is checked here: anyone who can read
// the project's organisation, viewers included (Ramón, 2026-10-24: "logged-in users with
// projects"). What an answer costs is recorded by the agent and counts toward the monthly cap.
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const parsed = parseChatRequest(await readJson(request));
  if (typeof parsed === "string") return fail(parsed, 400);

  const reads = await readsProjectOrganization(supabase, parsed.projectId);
  if (reads === "missing") return fail("Unknown project.", 404);
  if (reads === "no") return fail("You cannot read this project's organisation.", 403);
  if (reads === "read_only") return fail(READ_ONLY_ASSISTANT, 409);

  try {
    return Response.json(await askAssistant(parsed));
  } catch (error) {
    return agentFailure("POST /api/chat", error);
  }
}
