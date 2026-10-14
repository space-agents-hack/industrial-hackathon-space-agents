import { parseOrganizationName } from "@/lib/admin";
import { dbFailure, fail, requirePlatformAdmin } from "@/lib/admin-route";
import { readJson } from "@/lib/validation";

// Create an organisation. Body { name } → { id }. Platform admins only (create_organization
// checks too). The page then adds its first admin through POST /api/admin/people, the same path
// as any other person, so there is one way people get in.
export async function POST(request: Request) {
  const parsed = parseOrganizationName(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);

  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;

  const { data: id, error } = await context.supabase.rpc("create_organization", { org_name: parsed.value.name });
  if (error) return dbFailure("POST /api/admin/organizations", error, "The organisation could not be created.");
  return Response.json({ id }, { status: 201 });
}
