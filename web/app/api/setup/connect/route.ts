import { parseProductionAnswers } from "@/lib/production-answers";
import { claimBootstrap, guard, releaseBootstrap, runBootstrap } from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// "Create production" on the local Setup page: runs scripts/bootstrap.sh with the form's answers
// and streams its output back. Only under `make dev` (lib/local-request.ts).
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;

  const parsed = parseProductionAnswers(await readJson(request));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  if (!claimBootstrap()) {
    return Response.json({ error: "Setup is already running in another tab." }, { status: 409 });
  }
  try {
    return new Response(runBootstrap(parsed.value, request.signal), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    releaseBootstrap();
    throw error;
  }
}
