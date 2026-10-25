import { describeDbError } from "@/lib/admin";
import { dbFailure, fail, requireManager } from "@/lib/admin-route";
import {
  DELETE_BATCH,
  type DeleteOutcome,
  NO_DELETION,
  addOutcome,
  batches,
  confirmsClear,
  parseDeleteRequest,
} from "@/lib/regulations";
import { readJson } from "@/lib/validation";

// A library of a few hundred regulations is a handful of batches of a second or two each.
export const maxDuration = 60;

const BUCKET = "regulations";

// Delete regulations from an organisation's library (SYS-46, #56). Body { organization_id,
// regulation_ids } or { organization_id, all: true, confirm } → what was deleted. Admins of that
// organisation and platform admins; delete_regulations checks again in the same transaction.
//
// As the signed-in admin, never with the secret key: the rows through the database function, the
// PDFs through the Storage policy for admins. Rows first, then the bytes, as for case files
// (lib/case-upload.ts): a failure in between leaves files nobody can reach rather than a
// regulation listed without its PDF.
export async function DELETE(request: Request) {
  const parsed = parseDeleteRequest(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { organizationId, target } = parsed.value;

  const context = await requireManager(organizationId);
  if (context instanceof Response) return context;
  const { supabase } = context;

  let ids: string[];
  if ("all" in target) {
    const { data: org } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    if (!org || !confirmsClear(target.confirm, org.name)) {
      return fail("Type the organisation's name exactly to clear its library.", 400);
    }
    ids = [];
    // PostgREST returns at most 1000 rows per request.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("regulations")
        .select("id")
        .eq("organization_id", organizationId)
        .order("id")
        .range(from, from + 999);
      if (error) return dbFailure("DELETE /api/regulations", error, "The library could not be read.");
      ids.push(...data.map((r) => r.id));
      if (data.length < 1000) break;
    }
  } else {
    ids = target.ids;
  }

  let total: DeleteOutcome = NO_DELETION;
  let stopped: string | null = null;
  let status = 200;
  for (const batch of batches(ids, DELETE_BATCH)) {
    const { data, error } = await supabase.rpc("delete_regulations", { org: organizationId, regulation_ids: batch });
    if (error) {
      if (total.regulations === 0) return dbFailure("DELETE /api/regulations", error, "The regulations could not be deleted.");
      // Earlier batches are gone and stay gone; say how far it got, so pressing again finishes.
      const described = describeDbError(error, "The rest could not be deleted.");
      if (described.status === 500) console.error("DELETE /api/regulations: a later batch failed", error);
      stopped = described.message;
      status = described.status;
      break;
    }
    total = addOutcome(total, data);
  }

  let warning: string | null = null;
  for (const chunk of batches(total.paths, 100)) {
    const { error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) {
      console.error("DELETE /api/regulations: removing PDFs failed", error);
      warning = `The regulations are deleted, but some of their stored PDFs were not: ${error.message}`;
      break;
    }
  }

  const body = {
    regulations: total.regulations,
    versions: total.versions,
    paragraphs: total.paragraphs,
    requirements_unlinked: total.requirementsUnlinked,
    ...(warning ? { warning } : {}),
  };
  if (stopped) {
    return Response.json(
      { ...body, error: `Deleted ${total.regulations} of ${ids.length} regulations, then stopped: ${stopped}` },
      { status },
    );
  }
  return Response.json(body);
}
