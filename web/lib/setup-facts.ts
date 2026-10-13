import "server-only";

import { access } from "node:fs/promises";
import path from "node:path";

import { connection } from "next/server";

import { type AgentHealth, type SetupFacts, databaseOf } from "@/lib/setup";

// What the Setup page can observe: the configuration of this server, the agent's health over
// HTTP and, on a developer's machine, the link files the CLIs leave behind. It reads no secret,
// writes nothing, and must work on a clone where nothing has been set up.
export async function gatherSetupFacts(): Promise<SetupFacts> {
  // Request-time only: a prerendered answer would show the state of the build machine.
  await connection();

  const onVercel = Boolean(process.env.VERCEL);
  // On Vercel there is no checkout to look at. The steps logic treats production as linked.
  const [agent, supabaseLinked, vercelWebLinked, vercelAgentLinked] = await Promise.all([
    agentHealth(),
    onVercel ? null : exists("..", "supabase", ".temp", "project-ref"),
    onVercel ? null : exists(".vercel", "project.json"),
    onVercel ? null : exists("..", "agent", ".vercel", "project.json"),
  ]);
  return {
    onVercel,
    database: databaseOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
    agent,
    supabaseLinked,
    vercelWebLinked,
    vercelAgentLinked,
  };
}

// Relative to web/, which is where `next dev` runs. The ignore comment stops the bundler from
// packing the whole checkout into the deployed function "in case" this path points anywhere in
// it; in production the function is never called.
async function exists(...segments: string[]): Promise<boolean> {
  try {
    await access(path.join(/* turbopackIgnore: true */ process.cwd(), ...segments));
    return true;
  } catch {
    return false;
  }
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
