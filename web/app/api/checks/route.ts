import { agentFailure, fail } from "@/lib/admin-route";
import { runCertivityChecks } from "@/lib/agent-admin";
import { SUBMISSION_MAX_BYTES, isExpectedFile } from "@/lib/certivity";
import { permissionsIn } from "@/lib/access";
import { fetchAccess } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid, readJson } from "@/lib/validation";

// Body { text, organization_id, run_id? }: a run's output or the contents of a dropped file, and the
// organisation whose regulation library the citations are checked against (ADR-0006). Anyone who
// can read that organisation may check, viewers included. A dropped file never reaches the
// database. With run_id the agent stores the result with that run if the text is the run's own
// file (run_checks, #51): the latest check of a draft, which anyone who can read the draft could
// recompute anyway. The agent reads with its secret key, so access is checked here.
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);

  const body = await readJson(request);
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    return fail('Expected a JSON body like { "text": "..." }.', 400);
  }
  const { text, organization_id: org, expected, run_id: runId } = body as {
    text: string;
    organization_id?: unknown;
    expected?: unknown;
    run_id?: unknown;
  };
  // An expected.json the user chose, scored against for this check only and never stored.
  if (expected !== undefined && expected !== null && !isExpectedFile(expected)) {
    return fail("expected must be an expected.json: an object with a requirements or changes list.", 400);
  }
  if (org !== undefined && org !== null && !(typeof org === "string" && isUuid(org))) {
    return fail("organization_id must be an organisation id.", 400);
  }
  if (typeof org === "string" && !permissionsIn(await fetchAccess(supabase), org).read) {
    return fail("You cannot read this organisation.", 403);
  }
  if (runId !== undefined && runId !== null && !(typeof runId === "string" && isUuid(runId))) {
    return fail("run_id must be a run id.", 400);
  }
  // Asked as the caller: RLS hides a run of an organisation they cannot read. Only the id, since
  // the output is already in the body.
  if (typeof runId === "string") {
    const { data: run } = await supabase.from("runs").select("id").eq("id", runId).maybeSingle();
    if (!run) return fail("Unknown run.", 404);
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
        typeof runId === "string" ? runId : null,
      ),
    );
  } catch (error) {
    return agentFailure("POST /api/checks", error);
  }
}
