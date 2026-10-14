import { isProviderId } from "@/lib/admin";
import { agentFailure, fail, requireManager } from "@/lib/admin-route";
import { listProviderModels } from "@/lib/agent-admin";
import { isUuid } from "@/lib/validation";

// GET ?org=<id>&provider=<anthropic|openai|openrouter|deepseek> → { models: ModelOption[] }.
// A 409 means no key is connected for that provider; the page says "connect a key first".
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const org = params.get("org");
  const provider = params.get("provider");
  if (!isUuid(org)) return fail("Unknown organisation.", 400);
  if (!isProviderId(provider)) return fail("Unknown provider.", 400);

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  try {
    const models = await listProviderModels(org, provider);
    return Response.json({ models }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return agentFailure("GET /api/admin/models", error);
  }
}
