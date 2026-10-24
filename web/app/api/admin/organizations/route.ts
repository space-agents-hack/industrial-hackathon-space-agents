import { parseCreateOrganization, parseRenameOrganization } from "@/lib/admin";
import { dbFailure, fail, requireManager, requirePlatformAdmin } from "@/lib/admin-route";
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

// Rename an organisation. Body { org, name }. Its admins and platform admins (rename_organization
// checks too, and audits the old and the new name). The name is the `team_id` of every submission
// its runs write from now on (#35), so a team renames its organisation to its platform team id.
export async function PATCH(request: Request) {
  const parsed = parseRenameOrganization(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);

  const context = await requireManager(parsed.value.org);
  if (context instanceof Response) return context;

  const { error } = await context.supabase.rpc("rename_organization", {
    org: parsed.value.org,
    new_name: parsed.value.name,
  });
  if (error) return dbFailure("PATCH /api/admin/organizations", error, "The organisation could not be renamed.");
  return Response.json({ ok: true });
}
