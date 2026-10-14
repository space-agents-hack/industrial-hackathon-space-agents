import { parseProviderDelete, parseProviderKey, providerLabel } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { checkProviderKey } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Paste or replace a key. Body { org, provider, api_key }. The key is tested with one cheap call
// to the provider (through the agent) before it is stored, so a typo is caught here and not at
// the next run. It goes from this handler to the agent and to Vault, and nowhere else: it is not
// logged, not echoed back, and the page only ever sees its last four characters.
export async function POST(request: Request) {
  const parsed = parseProviderKey(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, provider, apiKey } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  let check: { ok: boolean; detail: string };
  try {
    check = await checkProviderKey(provider, apiKey);
  } catch (error) {
    return agentFailure("POST /api/admin/providers: check", error);
  }
  if (!check.ok) {
    const detail = check.detail.trim();
    return fail(`${providerLabel(provider)} refused this key${detail ? `: ${detail}` : "."}`, 400);
  }

  const { error } = await context.supabase.rpc("set_provider_key", {
    org,
    key_provider: provider,
    api_key: apiKey,
    key_source: "pasted",
  });
  if (error) return dbFailure("POST /api/admin/providers", error, "The key could not be stored.");
  return Response.json({ ok: true });
}

// Body { org, provider }. Runs that need this provider fail from now on until a key is added.
export async function DELETE(request: Request) {
  const parsed = parseProviderDelete(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, provider } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;

  const { error } = await context.supabase.rpc("delete_provider_key", { org, key_provider: provider });
  if (error) return dbFailure("DELETE /api/admin/providers", error, "The key could not be removed.");
  return Response.json({ ok: true });
}
