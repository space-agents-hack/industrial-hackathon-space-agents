import "server-only";

import { connection } from "next/server";

import { type AgentHealth, type SetupFacts, databaseOf } from "@/lib/setup";
import { githubAppStatus, knownProjectRef, runCli } from "@/lib/setup-commands";

// What the Setup page can observe: the configuration of this server, the agent's health over
// HTTP and, under `make dev`, which secrets the repository's production environment holds (names
// only, through your `gh` sign-in). It reads no secret, writes nothing, and must work on a clone
// where nothing has been set up.
export async function gatherSetupFacts(): Promise<SetupFacts> {
  // Request-time only: a prerendered answer would show the state of the build machine.
  await connection();

  const onVercel = Boolean(process.env.VERCEL);
  const local = !onVercel && process.env.SETUP_LOOPBACK_ONLY === "1";
  const [agent, github, githubApp, projectRef] = await Promise.all([
    agentHealth(),
    local ? productionSecrets() : null,
    local ? githubAppStatus() : null,
    local ? knownProjectRef() : null,
  ]);
  return {
    onVercel,
    database: databaseOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
    agent,
    repo: github?.repo ?? null,
    productionSecrets: github?.names ?? null,
    // Deployed, the app counts as connected when its key reached this deployment.
    githubApp: onVercel ? (process.env.GH_APP_ID && process.env.GH_APP_PRIVATE_KEY_B64 ? { slug: "", installed: true } : null) : githubApp,
    projectRef,
  };
}

// A repository whose Deploy workflow never ran has no production environment, and GitHub answers
// 404: that is "nothing there yet", not "could not ask".
async function productionSecrets(): Promise<{ repo: string; names: string[] } | null> {
  const repo = await runCli("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (!repo.ok || !repo.stdout) return null;
  const listed = await runCli("gh", ["api", "repos/{owner}/{repo}/environments/production/secrets", "--jq", ".secrets[].name"]);
  return { repo: repo.stdout, names: listed.ok ? listed.stdout.split("\n").filter(Boolean) : [] };
}

async function agentHealth(): Promise<AgentHealth> {
  // On a fresh clone AGENT_URL is not set yet; the agent would still be on its default port.
  const baseUrl = process.env.AGENT_URL ?? (process.env.VERCEL ? "" : "http://127.0.0.1:8000");
  if (!baseUrl) {
    return { reachable: false, reason: "AGENT_URL is not set on the web server." };
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      cache: "no-store",
      // The page must not hang on a dead agent; the agent answers /health in milliseconds.
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return { reachable: false, reason: `The agent answered ${response.status} to /health.` };
    }
    const body: unknown = await response.json();
    const field = (name: string): string =>
      typeof body === "object" && body !== null && name in body
        ? String((body as Record<string, unknown>)[name])
        : "unknown";
    return { reachable: true, model: field("model"), version: field("version") };
  } catch {
    return { reachable: false, reason: "The agent service is not answering." };
  }
}
