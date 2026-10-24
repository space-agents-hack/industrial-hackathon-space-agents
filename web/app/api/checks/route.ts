import { agentFailure, fail } from "@/lib/admin-route";
import { runCertivityChecks } from "@/lib/agent-admin";
import { SUBMISSION_MAX_BYTES } from "@/lib/certivity";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { readJson } from "@/lib/validation";

// Body { text }: a run's output or the contents of a dropped file. Any signed-in person may check,
// viewers included: it reads nothing and writes nothing, and the text never reaches the database.
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const body = await readJson(request);
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    return fail('Expected a JSON body like { "text": "..." }.', 400);
  }
  const text = (body as { text: string }).text;
  if (new TextEncoder().encode(text).length > SUBMISSION_MAX_BYTES) {
    return fail("The file is over Certivity's 5 MB limit.", 413);
  }

  try {
    return Response.json(await runCertivityChecks(text));
  } catch (error) {
    return agentFailure("POST /api/checks", error);
  }
}
