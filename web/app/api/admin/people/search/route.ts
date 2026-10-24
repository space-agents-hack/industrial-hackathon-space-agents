import type { NextRequest } from "next/server";

import { dbFailure, fail, requireManager } from "@/lib/admin-route";
import { isUuid } from "@/lib/validation";

// GET ?org=<id>&q=<text>: existing accounts to pick from in Add a person. The database decides
// whose accounts the caller may see (find_people): every account for a platform admin, people of
// the organisations they manage for an organisation admin. `role` is the person's role in `org`
// when they are already in it, so the form can say so instead of adding them twice.
export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get("org");
  const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 320);
  if (!isUuid(org)) return fail("Unknown organisation.", 400);

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const { data, error } = await context.supabase.rpc("find_people", { org, search: q });
  if (error) return dbFailure("GET /api/admin/people/search", error, "The search failed.");
  return Response.json({
    people: data.map((row) => ({ user_id: row.user_id, email: row.email, role: row.role, status: row.status })),
  });
}
