import { dbFailure, fail, requirePlatformAdmin } from "@/lib/admin-route";
import { parseRunId, readRuns, startWorkflow } from "@/lib/github";

// Runs of the Deploy workflow (or, with ?workflow=bootstrap, the Bootstrap workflow) for Admin.
// Platform admins only: a run's names and errors describe the deployment, not one organisation.
export async function GET(request: Request) {
  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;
  const params = new URL(request.url).searchParams;
  const workflow = params.get("workflow") === "bootstrap" ? "bootstrap.yml" : "deploy.yml";
  const runs = await readRuns(workflow, parseRunId(params.get("run")));
  return Response.json(runs, { headers: { "cache-control": "no-store" } });
}

// Start a release of main, the same as "Run workflow" on GitHub. No password: it deploys only
// what is already on main, through every check.
export async function POST() {
  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;
  const started = await startWorkflow("deploy.yml");
  if (!started.ok) return fail(started.error, 502);
  const { error } = await context.supabase.rpc("record_deployment_change", {
    change: "deployment.release_started",
    detail: {},
  });
  if (error) return dbFailure("POST /api/admin/releases", error, "The release started but was not written to the audit log.");
  return Response.json({ started: true });
}
