import "server-only";

import { access } from "node:fs/promises";
import path from "node:path";

import { connection } from "next/server";

import { type AgentHealth, type SetupFacts, environmentOf } from "@/lib/setup";
import { supabaseEnv } from "@/lib/supabase/env";

// What the Setup page can observe: the agent's health over HTTP and, on a developer's machine,
// the link files the CLIs leave behind. It reads no secret and writes nothing.
export async function gatherSetupFacts(): Promise<SetupFacts> {
  // Request-time only: a prerendered answer would show the state of the build machine.
  await connection();

  const environment = environmentOf(supabaseEnv().url);
  // On Vercel there is no checkout to look at. The steps logic treats production as linked.
  const onDisk = environment === "local" && !process.env.VERCEL;
  const [agent, supabaseLinked, vercelWebLinked, vercelAgentLinked] = await Promise.all([
    agentHealth(),
    onDisk ? exists("..", "supabase", ".temp", "project-ref") : null,
    onDisk ? exists(".vercel", "project.json") : null,
    onDisk ? exists("..", "agent", ".vercel", "project.json") : null,
  ]);
  return { environment, agent, supabaseLinked, vercelWebLinked, vercelAgentLinked };
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
  const baseUrl = process.env.AGENT_URL;
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
    return {
      reachable: false,
      reason: "The agent service did not answer. Locally: is `make dev` running?",
    };
  }
}
