import { guard, startRelease } from "@/lib/setup-commands";

// Starts the Deploy workflow on main, the same as pressing "Run workflow" on GitHub.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const result = await startRelease();
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
