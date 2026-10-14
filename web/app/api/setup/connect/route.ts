import { parseConnectAnswers } from "@/lib/connect-answers";
import { guard, isBootstrapRunning, runBootstrap, writeSaved } from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// Runs scripts/bootstrap.sh with the form's answers and streams its output back. The answers are
// never logged: they go from the request body to the script's stdin.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;

  const body = await readJson(request);
  const parsed = parseConnectAnswers(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (isBootstrapRunning()) {
    return Response.json({ error: "A connection is already running." }, { status: 409 });
  }

  // Saved before running, not after: a run that fails half-way is exactly when the values are
  // needed again.
  const remember = typeof body === "object" && body !== null && "remember" in body && body.remember === true;
  if (remember) {
    const answers = parsed.value;
    await writeSaved({
      project_ref: answers.project_ref,
      db_password: answers.db_password,
      supabase_token: answers.supabase_token,
      vercel_token: answers.vercel_token,
      agent_model: answers.agent_model,
      provider_key: answers.provider_key ?? "",
      users: answers.users,
    });
  }

  return new Response(runBootstrap(parsed.value, request.signal), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
