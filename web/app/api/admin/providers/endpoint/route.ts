import { parseProviderEndpoint, providerLabel } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { checkProviderEndpoint } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Connect or change the organisation's own model server (Ollama, SYS-30). Body { org, provider,
// base_url, auth_scheme, username?, secret? }. The agent asks the server for its models first, so
// a wrong port or password is caught here and not at the next run. The token or password goes
// from this handler to the agent and to Vault, and nowhere else: not logged, not echoed back.
//
// The agent, not the browser, calls the server. A server on "localhost" therefore has to be on the
// machine the agent runs on; a hosted agent reaches one only through an address it can route to.
export async function POST(request: Request) {
  const parsed = parseProviderEndpoint(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const endpoint = parsed.value;

  const context = await requireManager(endpoint.org);
  if (context instanceof Response) return context;

  let check: { ok: boolean; detail: string };
  try {
    check = await checkProviderEndpoint(endpoint);
  } catch (error) {
    return agentFailure("POST /api/admin/providers/endpoint: check", error);
  }
  if (!check.ok) {
    const detail = check.detail.trim();
    return fail(`The ${providerLabel(endpoint.provider)} server did not answer as expected${detail ? `: ${detail}` : "."}`, 400);
  }

  const { error } = await context.supabase.rpc("set_provider_endpoint", {
    org: endpoint.org,
    key_provider: endpoint.provider,
    endpoint_url: endpoint.baseUrl,
    endpoint_auth: endpoint.authScheme,
    endpoint_username: endpoint.username ?? undefined,
    endpoint_secret: endpoint.secret ?? undefined,
  });
  if (error) return dbFailure("POST /api/admin/providers/endpoint", error, "The server could not be stored.");
  return Response.json({ ok: true, detail: check.detail });
}
