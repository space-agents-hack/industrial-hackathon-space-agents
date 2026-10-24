import { agentFailure, fail } from "@/lib/admin-route";
import { runCertivityChecks } from "@/lib/agent-admin";
import { SUBMISSION_MAX_BYTES } from "@/lib/certivity";
import { permissionsIn } from "@/lib/access";
import { fetchAccess } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid, readJson } from "@/lib/validation";

// Body { text, organization_id }: a run's output or the contents of a dropped file, and the
// organisation whose regulation library the citations are checked against (ADR-0006). Anyone who
// can read that organisation may check, viewers included: it writes nothing, and the text never
// reaches the database. The agent reads the library with its secret key, so the role is checked
// here.
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const body = await readJson(request);
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    return fail('Expected a JSON body like { "text": "..." }.', 400);
  }
  const { text, organization_id: org, expected } = body as {
    text: string;
    organization_id?: unknown;
    expected?: unknown;
  };
  // An expected.json the user chose, scored against for this check only and never stored.
  if (
    expected !== undefined &&
    expected !== null &&
    !(typeof expected === "object" && !Array.isArray(expected) && Array.isArray((expected as { requirements?: unknown }).requirements))
  ) {
    return fail("expected must be an expected.json: an object with a requirements list.", 400);
  }
  if (org !== undefined && org !== null && !(typeof org === "string" && isUuid(org))) {
    return fail("organization_id must be an organisation id.", 400);
  }
  if (typeof org === "string" && !permissionsIn(await fetchAccess(supabase), org).read) {
    return fail("You cannot read this organisation.", 403);
  }
  if (new TextEncoder().encode(text).length > SUBMISSION_MAX_BYTES) {
    return fail("The file is over Certivity's 5 MB limit.", 413);
  }

  try {
    return Response.json(
      await runCertivityChecks(
        text,
        typeof org === "string" ? org : null,
        (expected as Record<string, unknown> | null | undefined) ?? null,
      ),
    );
  } catch (error) {
    return agentFailure("POST /api/checks", error);
  }
}
