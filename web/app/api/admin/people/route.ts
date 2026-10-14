import { parseAddPerson, parseSetMember } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { createAuthUser } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Add a person. Body { org, email, role, password }. Two steps, in this order: the account
// (through the agent, which holds the key that may create users), then the place in the
// organisation (set_member, as the admin, which checks the role and writes the audit row).
// If the second step fails the account exists with no organisation, which grants nothing; adding
// the same email again picks it up.
//
// The app sends no email. The admin hands the password over themselves; the response says
// whether it applies (`created`), because an existing account keeps the password it had.
export async function POST(request: Request) {
  const parsed = parseAddPerson(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, email, role, password } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  let account: { userId: string; created: boolean };
  try {
    account = await createAuthUser(email, password);
  } catch (error) {
    return agentFailure("POST /api/admin/people", error);
  }

  const { error } = await context.supabase.rpc("set_member", {
    org,
    member: account.userId,
    member_role: role,
    member_status: "active",
  });
  if (error) return dbFailure("POST /api/admin/people: set_member", error, "The account exists, but it could not be added to the organisation.");
  return Response.json({ user_id: account.userId, created: account.created }, { status: 201 });
}

// Change a role or suspend / reactivate. Body { org, user_id, role, status }. The database
// refuses a change that would leave the organisation without an active admin, and that
// sentence is passed through as it is.
export async function PATCH(request: Request) {
  const parsed = parseSetMember(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, userId, role, status } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const { error } = await context.supabase.rpc("set_member", {
    org,
    member: userId,
    member_role: role,
    member_status: status,
  });
  if (error) return dbFailure("PATCH /api/admin/people", error, "The change could not be saved.");
  return Response.json({ ok: true });
}
