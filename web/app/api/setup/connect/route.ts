import { parseConnectAnswers } from "@/lib/connect-answers";
import { guard, isBootstrapRunning, runBootstrap } from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// Runs scripts/bootstrap.sh with the form's answers and streams its output back. The answers are
// never logged: they go from the request body to the script's stdin.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;

  const parsed = parseConnectAnswers(await readJson(request));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (isBootstrapRunning()) {
    return Response.json({ error: "A connection is already running." }, { status: 409 });
  }

  return new Response(runBootstrap(parsed.value, request.signal), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
