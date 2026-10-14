import { AgentError, advanceRun, describeAgentFailure } from "@/lib/agent";
import { actsInRunOrganization } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid, parseDecision, readJson } from "@/lib/validation";

// The run resumes while this function holds the connection to the agent (lib/agent.ts).
// 300 s is the ceiling on Vercel Hobby; Pro allows 800.
export const maxDuration = 300;

export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[id]">) {
  const supabase = await createClient();
  const user = await getSessionUser(supabase);
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await ctx.params;
  if (!isUuid(id)) return Response.json({ error: "Unknown approval." }, { status: 404 });

  const parsed = parseDecision(await readJson(request));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { decision, note } = parsed.value;

  // RLS refuses a viewer's decision as "zero rows", which would read as "already decided". Ask
  // first so a viewer is told the real reason. The update below is still the check that counts.
  const { data: target } = await supabase.from("approvals").select("run_id").eq("id", id).maybeSingle();
  if (target && (await actsInRunOrganization(supabase, target.run_id)) === "no") {
    return Response.json({ error: "Viewers cannot decide approvals." }, { status: 403 });
  }

  // Updated as the user. RLS only lets a row through while it is still pending, so a second
  // decision (another tab, a teammate) matches zero rows instead of overwriting the first.
  const { data: decided, error } = await supabase
    .from("approvals")
    .update({ status: decision, note, decided_by: user.id })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, run_id, status");
  if (error) {
    console.error(`POST /api/approvals/${id}: update failed`, error);
    return Response.json({ error: "The decision could not be saved." }, { status: 500 });
  }
  if (decided.length === 0) {
    return Response.json(
      { error: "This approval has already been decided, or does not exist." },
      { status: 409 },
    );
  }
  const runId = decided[0].run_id;

  // The agent resumes only when every approval of the pause has an answer.
  const { count, error: countError } = await supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "pending");
  if (countError) {
    console.error(`POST /api/approvals/${id}: could not count pending approvals`, countError);
    return Response.json({
      status: decision,
      run_id: runId,
      resumed: false,
      warning: "The decision was saved, but the run was not resumed. Use Retry.",
    });
  }
  if ((count ?? 0) > 0) return Response.json({ status: decision, run_id: runId, resumed: false });

  try {
    await advanceRun(runId);
  } catch (agentError) {
    if (agentError instanceof AgentError && agentError.status === 409) {
      // Two reasons for a 409. A teammate resumed the run first: fine. Or the decision landed in
      // the instant between the agent writing the approval and marking the run paused, and the
      // run is now waiting with nothing to wait for. Look, and in that case try once more.
      const { data: run } = await supabase.from("runs").select("status").eq("id", runId).single();
      if (run?.status === "awaiting_approval") {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          await advanceRun(runId);
          return Response.json({ status: decision, run_id: runId, resumed: true });
        } catch (retryError) {
          console.error(`POST /api/approvals/${id}: retry of run ${runId} failed`, retryError);
          return Response.json({
            status: decision,
            run_id: runId,
            resumed: false,
            warning: describeAgentFailure(retryError),
          });
        }
      }
      return Response.json({ status: decision, run_id: runId, resumed: true });
    }
    console.error(`POST /api/approvals/${id}: decision saved but run ${runId} not resumed`, agentError);
    // The decision stands. The run page shows Retry while the run waits with nothing pending.
    return Response.json({
      status: decision,
      run_id: runId,
      resumed: false,
      warning: describeAgentFailure(agentError),
    });
  }
  return Response.json({ status: decision, run_id: runId, resumed: true });
}
