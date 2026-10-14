import { requirePlatformAdmin } from "@/lib/admin-route";
import { parseRunId, readReleases } from "@/lib/github";

// The Deploy workflow's runs for Admin › Releases. Platform admins only: a run's names and errors
// describe the deployment, not one organisation.
export async function GET(request: Request) {
  const context = await requirePlatformAdmin();
  if (context instanceof Response) return context;
  const run = parseRunId(new URL(request.url).searchParams.get("run"));
  return Response.json(await readReleases(run), { headers: { "cache-control": "no-store" } });
}
