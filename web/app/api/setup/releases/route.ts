import { parseRunId, readRuns } from "@/lib/github";
import { guard } from "@/lib/setup-commands";

// The Deploy workflow's runs for the local Setup page, read with your `gh` sign-in.
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const run = parseRunId(new URL(request.url).searchParams.get("run"));
  return Response.json(await readRuns("deploy.yml", run), { headers: { "cache-control": "no-store" } });
}
