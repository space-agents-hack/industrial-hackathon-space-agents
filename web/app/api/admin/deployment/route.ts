import { dbFailure, fail, requirePlatformAdmin } from "@/lib/admin-route";
import { parseDeploymentChange } from "@/lib/deployment";
import { saveDeployment, startWorkflow } from "@/lib/github";
import { passwordMatches } from "@/lib/step-up";
import { readJson } from "@/lib/validation";

// Admin › Deployment: store new values in GitHub and, if asked, run the Bootstrap workflow, which
// carries them to Vercel and Supabase and then releases (ADR-0005). Platform admins only, with
// their password typed again. The audit log gets the names of what changed, never the values.
export async function POST(request: Request) {
  // A form on another site cannot send JSON with the session cookie; this keeps it that way.
  if (!request.headers.get("content-type")?.startsWith("application/json")) return fail("Expected JSON.", 415);

  const parsed = parseDeploymentChange(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);

  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;
  if (!context.user.email || !(await passwordMatches(context.user.email, parsed.value.password))) {
    return fail("That is not your password.", 403);
  }

  const saved = await saveDeployment(parsed.value);
  if (saved.names.length) {
    const { error } = await context.supabase.rpc("record_deployment_change", {
      change: "deployment.values_saved",
      detail: { names: saved.names },
    });
    if (error) console.error("POST /api/admin/deployment: audit failed", error);
  }
  if (!saved.ok) {
    const done = saved.names.length ? ` Already saved: ${saved.names.join(", ")}.` : "";
    return fail(`${saved.error}${done}`, 502);
  }

  if (parsed.value.apply) {
    const started = await startWorkflow("bootstrap.yml", { release: "true" });
    if (!started.ok) return fail(`Saved ${saved.names.join(", ") || "nothing"}, but ${started.error}`, 502);
    const { error } = await context.supabase.rpc("record_deployment_change", {
      change: "deployment.reconfigure_started",
      detail: { names: saved.names },
    });
    if (error) return dbFailure("POST /api/admin/deployment", error, "Started, but not written to the audit log.");
  }
  return Response.json({ saved: saved.names, started: parsed.value.apply });
}
