import { agentFailureStatus, describeAgentFailure, ingestCase } from "@/lib/agent";
import { actsInCaseOrganization } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// The agent parses the case's files while this function holds the connection (lib/agent.ts). A
// scanned PDF with model transcription takes about a minute; the Pro ceiling is 800 s.
export const maxDuration = 800;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Not a part id." }, { status: 400 });

  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const acts = await actsInCaseOrganization(supabase, id);
  if (acts === "missing") return Response.json({ error: "That part does not exist here." }, { status: 404 });
  if (acts === "no") {
    return Response.json({ error: "Only admins and members of this organisation can add files." }, { status: 403 });
  }

  try {
    await ingestCase(id);
  } catch (agentError) {
    console.error(`POST /api/cases/${id}/ingest: not started`, agentError);
    return Response.json(
      { error: describeAgentFailure(agentError, "case") },
      { status: agentFailureStatus(agentError) },
    );
  }
  return Response.json({ id }, { status: 202 });
}
