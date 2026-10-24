import { dbFailure, fail, requireManager } from "@/lib/admin-route";
import { advanceRegulationImport, describeAgentFailure } from "@/lib/agent";
import type { Json } from "@/lib/database.types";
import { parseImportRequest } from "@/lib/regulations";
import { readJson } from "@/lib/validation";

// The first slice runs while this function holds the connection to the agent (lib/agent.ts).
// A slice lasts at most about 260 s (import_slice_s in agent/agent_service/settings.py), so 300 is
// enough on Hobby and Pro alike.
export const maxDuration = 300;

// Start an import into an organisation's library. Body { organization_id, source_name, index } →
// { id }. Admins of that organisation and platform admins (the database function checks too). The
// import is saved first and then handed to the agent; if the agent cannot be reached the import
// exists, stays queued, and the page offers Resume.
export async function POST(request: Request) {
  const parsed = parseImportRequest(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);

  const context = await requireManager(parsed.value.organizationId);
  if (context instanceof Response) return context;

  const { data: id, error } = await context.supabase.rpc("create_regulation_import", {
    org: parsed.value.organizationId,
    source_name: parsed.value.sourceName,
    regulation_index: parsed.value.index as Json,
  });
  if (error) return dbFailure("POST /api/regulations/imports", error, "The import could not be saved.");

  try {
    await advanceRegulationImport(id);
  } catch (agentError) {
    console.error(`POST /api/regulations/imports: import ${id} saved but not started`, agentError);
    return Response.json({ id, warning: describeAgentFailure(agentError, "import") }, { status: 201 });
  }
  return Response.json({ id }, { status: 201 });
}
