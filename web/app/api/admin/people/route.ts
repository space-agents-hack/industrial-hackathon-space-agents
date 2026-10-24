import { parseAddPerson, parseRemoveMember, parseSetMember } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { createAuthUser } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Add a person. Body { org, email, role, password? }. An email that already has an account (a
// person of another organisation, say) is given the role directly by add_member_by_email, with no
// password and no call to the agent: a person is one account with a place in each organisation.
// Only an email with no account needs a password. Then, in this order: the account (through the
// agent, which holds the key that may create users), then the place in the organisation
// (set_member, as the admin, which checks the role and writes the audit row). If the second step
// fails the account exists with no organisation, which grants nothing; adding the same email
// again picks it up.
//
// The app sends no email. The admin hands the password over themselves; the response says
// whether it applies (`created`), because an existing account keeps the password it had.
export async function POST(request: Request) {
  const parsed = parseAddPerson(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, email, role, password } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const existing = await context.supabase.rpc("add_member_by_email", {
    org,
    member_email: email,
    member_role: role,
  });
  if (existing.error) return dbFailure("POST /api/admin/people: add_member_by_email", existing.error, "The person could not be added.");
  // The generated type says string; no account is null.
  const existingId = existing.data as string | null;
  if (existingId) return Response.json({ user_id: existingId, created: false }, { status: 201 });

  if (password === null) {
    // `needs_password` lets the form ask for one instead of only showing the sentence.
    return Response.json(
      { error: "No account has this email yet. Give an initial password to create one.", needs_password: true },
      { status: 404 },
    );
  }

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

// Take a person out of the organisation. Body { org, user_id }. The account and its other
// memberships stay; the database refuses to remove the last active admin.
export async function DELETE(request: Request) {
  const parsed = parseRemoveMember(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, userId } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const { error } = await context.supabase.rpc("remove_member", { org, member: userId });
  if (error) return dbFailure("DELETE /api/admin/people", error, "The person could not be removed.");
  return Response.json({ ok: true });
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
