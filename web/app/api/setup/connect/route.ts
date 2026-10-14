import { randomBytes } from "node:crypto";

import { parseConnectAnswers } from "@/lib/connect-answers";
import {
  claimBootstrap,
  guard,
  readSaved,
  releaseBootstrap,
  runBootstrap,
  writeSaved,
} from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// Runs scripts/bootstrap.sh with the form's answers and streams its output back. The answers are
// never logged: they go from the request body to the script's stdin.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;

  if (!claimBootstrap()) {
    return Response.json({ error: "A connection is already running." }, { status: 409 });
  }
  try {
    const body = await readJson(request);
    const parsed = parseConnectAnswers(body);
    if (!parsed.ok) {
      releaseBootstrap();
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const flags = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    // The secret between web and agent is kept between runs: a new one on every Connect would
    // make the old web and the new agent disagree for the seconds between their promotions.
    const saved = await readSaved();
    const sharedSecret =
      flags.renew_shared_secret !== true && saved.shared_secret
        ? saved.shared_secret
        : randomBytes(32).toString("hex");
    const answers = { ...parsed.value, shared_secret: sharedSecret };

    // Saved before running, not after: a run that fails half-way is exactly when the values are
    // needed again.
    if (flags.remember === true) {
      await writeSaved({
        project_ref: answers.project_ref,
        db_password: answers.db_password,
        supabase_token: answers.supabase_token,
        vercel_token: answers.vercel_token,
        agent_model: answers.agent_model,
        provider_key: answers.provider_key ?? "",
        releases_token: answers.releases_token ?? "",
        shared_secret: sharedSecret,
        users: answers.users,
      });
    }
    return new Response(runBootstrap(answers, request.signal), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    releaseBootstrap();
    throw error;
  }
}
