import { SCRIPTED_MODEL, modelSourceOf, parseSettings } from "@/lib/admin";
import { agentFailure, dbFailure, fail, requireManager } from "@/lib/admin-route";
import { AgentAdminError, listProviderModels } from "@/lib/agent-admin";
import { readJson } from "@/lib/validation";

// Body { org, model, max_model_requests, monthly_cost_cap_usd }; an empty or null field means
// "use the deployment default" and is stored as null.
export async function POST(request: Request) {
  const parsed = parseSettings(await readJson(request));
  if (!parsed.ok) return fail(parsed.error, 400);
  const { org, model, maxModelRequests, monthlyCostCapUsd } = parsed.value;

  const context = await requireManager(org);
  if (context instanceof Response) return context;
  const { supabase } = context;

  // A model that is not in the provider's current list cannot be saved: the first run would fail
  // with an error from the provider, far from the person who typed it. Checked only when the
  // model changes, so lowering a cap still works while the agent or the provider is down.
  const { data: stored, error: readError } = await supabase
    .from("organization_settings")
    .select("model")
    .eq("organization_id", org)
    .maybeSingle();
  if (readError) return dbFailure("POST /api/admin/settings: read", readError, "The settings could not be read.");
  if (model !== null && model !== (stored?.model ?? null) && model !== SCRIPTED_MODEL) {
    const source = modelSourceOf(model);
    if (source === null || source === SCRIPTED_MODEL) {
      return fail(`"${model}" does not start with a provider this app knows.`, 400);
    }
    let known: boolean;
    try {
      known = (await listProviderModels(org, source)).some((option) => option.id === model);
    } catch (error) {
      if (!(error instanceof AgentAdminError)) return agentFailure("POST /api/admin/settings", error);
      return fail(
        `The model was not saved: the list of models could not be checked. ${error.userMessage}`,
        error.status === 409 ? 409 : 502,
      );
    }
    if (!known) return fail(`${model} is not in the provider's list of models.`, 400);
  }

  const { error } = await supabase.rpc("update_organization_settings", {
    org,
    // The generated types say `string`; null is what "use the default" is in the function.
    new_model: model as string,
    new_max_model_requests: maxModelRequests as number,
    new_monthly_cost_cap_usd: monthlyCostCapUsd as number,
  });
  if (error) return dbFailure("POST /api/admin/settings", error, "The settings could not be saved.");
  return Response.json({ ok: true });
}
