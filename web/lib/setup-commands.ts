import "server-only";

import { execFile, spawn } from "node:child_process";
import path from "node:path";

import { type RequestFacts, refuseUnlessLocal } from "@/lib/local-request";
import type { ProductionAnswers } from "@/lib/production-answers";

// Runs CLIs on this machine for the local Setup page. Every route that uses this
// calls `guard()` first; see lib/local-request.ts for who is allowed and why.

export function guard(request: Request): Response | null {
  const facts: RequestFacts = {
    onVercel: Boolean(process.env.VERCEL),
    nodeEnv: process.env.NODE_ENV,
    loopbackOnly: process.env.SETUP_LOOPBACK_ONLY === "1",
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    contentType: request.headers.get("content-type"),
    fetchSite: request.headers.get("sec-fetch-site"),
  };
  const status = refuseUnlessLocal(facts);
  return status === null ? null : new Response(null, { status });
}

// `next dev` runs in web/. The ignore comment keeps the bundler from packing the checkout into
// the output; this code never runs in a build.
function repoRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), "..");
}

// Only what the CLIs need to find themselves and their sign-in. The dev server's own environment
// (the web's .env.local) is not passed on.
function childEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function runCli(command: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    // A workflow job's log runs to megabytes; past the 1 MB default the call would fail.
    const options = { cwd: repoRoot(), env: childEnv() as NodeJS.ProcessEnv, timeout: timeoutMs, maxBuffer: 32 << 20 };
    execFile(command, args, options, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout).trim() });
    });
  });
}

// One at a time: two runs would race on the same projects and secrets. Claimed in one synchronous
// step, before any await, so two quick submits cannot both get it.
let bootstrapRunning = false;

export function claimBootstrap(): boolean {
  if (bootstrapRunning) return false;
  bootstrapRunning = true;
  return true;
}

export function releaseBootstrap(): void {
  bootstrapRunning = false;
}

// scripts/bootstrap.sh with the answers on stdin, its output streamed back as it comes. The last
// line is `exit <code>`, which the form reads to know how it ended. Nothing is saved on this
// machine: the values go to GitHub, Vercel and Supabase and are gone from here when it ends.
export function runBootstrap(answers: ProductionAnswers, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const child = spawn("bash", ["scripts/bootstrap.sh", "--from-json"], {
    cwd: repoRoot(),
    env: childEnv() as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(answers));
  // Closing the page stops the run. The script is safe to run again from the start.
  signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk));
      child.stdout.on("data", send);
      child.stderr.on("data", send);
      child.on("close", (code) => {
        bootstrapRunning = false;
        controller.enqueue(encoder.encode(`\nexit ${code ?? 1}\n`));
        controller.close();
      });
      child.on("error", (error) => {
        bootstrapRunning = false;
        controller.enqueue(encoder.encode(`\nCould not start bash: ${error.message}\nexit 1\n`));
        controller.close();
      });
    },
    cancel() {
      child.kill("SIGTERM");
    },
  });
}

// The organisations and projects a Supabase token reaches, for the form's choice. Names only.
export type SupabaseChoices =
  | { ok: true; orgs: { slug: string; name: string }[]; projects: { ref: string; name: string; org: string }[] }
  | { ok: false; error: string };

export async function supabaseChoices(token: string): Promise<SupabaseChoices> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`https://api.supabase.com${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  };
  try {
    const [orgs, projects] = (await Promise.all([get("/v1/organizations"), get("/v1/projects")])) as [
      { slug?: string; id?: string; name?: string }[],
      { ref?: string; id?: string; name?: string; organization_slug?: string; organization_id?: string }[],
    ];
    return {
      ok: true,
      orgs: orgs.map((o) => ({ slug: String(o.slug ?? o.id ?? ""), name: String(o.name ?? "") })),
      projects: projects.map((p) => ({
        ref: String(p.ref ?? p.id ?? ""),
        name: String(p.name ?? ""),
        org: String(p.organization_slug ?? p.organization_id ?? ""),
      })),
    };
  } catch {
    return { ok: false, error: "Supabase refused the token." };
  }
}

// Who is setting this up, to prefill the first admin's email.
export async function gitEmail(): Promise<string> {
  const result = await runCli("git", ["config", "user.email"]);
  return result.ok ? result.stdout : "";
}

export async function startRelease(): Promise<{ ok: boolean; url: string | null; detail: string }> {
  const started = await runCli("gh", ["workflow", "run", "deploy.yml", "--ref", "main"]);
  if (!started.ok) {
    return { ok: false, url: null, detail: "GitHub refused to start the Deploy workflow." };
  }
  // The run appears in the list a moment after it is requested.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const listed = await runCli("gh", [
      "run", "list", "--workflow", "deploy.yml", "--event", "workflow_dispatch",
      "--limit", "1", "--json", "url", "--jq", ".[0].url",
    ]);
    if (listed.ok && listed.stdout) return { ok: true, url: listed.stdout, detail: "Started." };
  }
  return { ok: true, url: null, detail: "Started; open the repository's Actions tab to follow it." };
}

// Production as seen from this machine: the address setup stored in GitHub
// (PRODUCTION_URL) and its deep health check, which covers web, agent and Supabase Auth in one
// request. Reads only.
export type ProductionStatus =
  | { known: false }
  | { known: true; url: string; checks: Record<string, string> | null; detail: string };

export async function productionStatus(): Promise<ProductionStatus> {
  const variable = await runCli("gh", ["variable", "get", "PRODUCTION_URL"]);
  const url = variable.ok ? variable.stdout.replace(/\/+$/, "") : "";
  if (!/^https:\/\/[\w.-]+$/.test(url)) return { known: false };
  try {
    const response = await fetch(`${url}/api/health/deep`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json().catch(() => null);
    const checks =
      typeof body === "object" && body !== null
        ? Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : null;
    return { known: true, url, checks, detail: response.ok ? "Answering." : `Answers ${response.status}.` };
  } catch {
    return { known: true, url, checks: null, detail: "Does not answer yet." };
  }
}
