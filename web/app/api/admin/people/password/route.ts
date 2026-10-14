import { parseSetPassword } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { setAuthPassword } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Set a new password for a person. Body { org, user_id, password }.
//
// can_reset_password() is asked first, as the admin: it is true only if they manage every
// organisation the person belongs to and the person is not a platform admin. Without it, the
// admin of one client could take over someone who is also an admin elsewhere. The agent, which
// performs the change with the secret key, does not know about organisations, so this check is
// the only one; it must stay before the call.
export async function POST(request: Request) {
  const parsed = parseSetPassword(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, userId, password } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const { data: allowed, error } = await context.supabase.rpc("can_reset_password", { member: userId });
  if (error) return dbFailure("POST /api/admin/people/password", error, "The permission could not be checked.");
  if (allowed !== true) {
    return fail(
      "You cannot set this person's password: they also belong to an organisation you do not manage, or they are a platform admin.",
      403,
    );
  }

  try {
    await setAuthPassword(userId, password);
  } catch (error) {
    return agentFailure("POST /api/admin/people/password", error);
  }
  return Response.json({ ok: true });
}
