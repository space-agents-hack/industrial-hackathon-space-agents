import { parseCreateOrganization } from "@/lib/admin";
import { dbFailure, fail, requirePlatformAdmin } from "@/lib/admin-route";
import { readJson } from "@/lib/validation";

// Create an organisation. Body { name, admin_email? } → { id }. Platform admins only
// (create_organization_with_admin checks too). The first admin is an existing account, made admin
// in the same transaction, so a typo in the email creates nothing. Without an email the
// organisation starts empty and its people are added from People, like anyone else's.
export async function POST(request: Request) {
  const parsed = parseCreateOrganization(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);

  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;

  const { data: id, error } = await context.supabase.rpc("create_organization_with_admin", {
    org_name: parsed.value.name,
    admin_email: parsed.value.adminEmail ?? "",
  });
  if (error) return dbFailure("POST /api/admin/organizations", error, "The organisation could not be created.");
  return Response.json({ id }, { status: 201 });
}
