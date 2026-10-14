import { supabaseEnv } from "@/lib/supabase/env";

// The whole chain in one request, for the deploy smoke test and the watchdog: this function runs,
// it reaches the agent with the shared secret, the agent reaches the database with its key, and
// Supabase Auth answers. /api/health only proves the first.
//
// Public on purpose (the watchdog has no session). It reveals which link is broken, nothing else.
export async function GET() {
  const checks: Record<string, string> = { web: "ok" };

  const agentUrl = process.env.AGENT_URL;
  const secret = process.env.AGENT_SHARED_SECRET;
  if (!agentUrl || !secret) {
    checks.agent = "AGENT_URL or AGENT_SHARED_SECRET is not set on the web.";
  } else {
    try {
      const response = await fetch(`${agentUrl.replace(/\/+$/, "")}/ready`, {
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      checks.agent =
        response.status === 200
          ? "ok"
          : response.status === 401
            ? "The agent rejected the shared secret: web and agent hold different AGENT_SHARED_SECRET."
            : `The agent answered ${response.status} to /ready.`;
    } catch {
      checks.agent = "The agent did not answer.";
    }
  }

  try {
    const { url, publishableKey } = supabaseEnv();
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: publishableKey },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    checks.auth = response.ok ? "ok" : `Supabase Auth answered ${response.status}.`;
  } catch {
    checks.auth = "Supabase did not answer, or its variables are not set on the web.";
  }

  const healthy = Object.values(checks).every((value) => value === "ok");
  return Response.json(checks, { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } });
}
