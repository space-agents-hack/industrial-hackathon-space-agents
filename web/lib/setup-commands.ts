import "server-only";

import { execFile, spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectAnswers } from "@/lib/connect-answers";
import { type RequestFacts, refuseUnlessLocal } from "@/lib/local-request";
import { EMPTY_SETUP, type SavedSetup, parseSetup, serializeSetup } from "@/lib/saved-setup";

// Runs the repository's own scripts and CLIs for the local Setup page. Every route that uses this
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

function run(command: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: repoRoot(), env: childEnv() as NodeJS.ProcessEnv, timeout: timeoutMs }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout).trim() });
    });
  });
}

export type CliStatus = { gh: boolean; vercel: boolean; supabase: boolean; repo: string | null };

export async function cliStatus(): Promise<CliStatus> {
  const [gh, vercel, supabase, repo] = await Promise.all([
    run("gh", ["auth", "status"]),
    run("vercel", ["whoami"]),
    run("supabase", ["projects", "list"]),
    run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
  ]);
  return {
    gh: gh.ok,
    vercel: vercel.ok,
    supabase: supabase.ok,
    repo: repo.ok && repo.stdout ? repo.stdout : null,
  };
}

// One at a time: two runs would race on the same Vercel projects and GitHub secrets.
let bootstrapRunning = false;

export function isBootstrapRunning(): boolean {
  return bootstrapRunning;
}

// The bootstrap script with the answers on stdin, its output streamed back line by line. The last
// line is `exit <code>`, which the form reads to know how it ended.
export function runBootstrap(answers: ConnectAnswers, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  bootstrapRunning = true;
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

export async function startRelease(): Promise<{ ok: boolean; url: string | null; detail: string }> {
  const started = await run("gh", ["workflow", "run", "deploy.yml", "--ref", "main"]);
  if (!started.ok) {
    return { ok: false, url: null, detail: "GitHub refused to start the Deploy workflow." };
  }
  // The run appears in the list a moment after it is requested.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const listed = await run("gh", [
      "run", "list", "--workflow", "deploy.yml", "--event", "workflow_dispatch",
      "--limit", "1", "--json", "url", "--jq", ".[0].url",
    ]);
    if (listed.ok && listed.stdout) return { ok: true, url: listed.stdout, detail: "Started." };
  }
  return { ok: true, url: null, detail: "Started; open the repository's Actions tab to follow it." };
}

// `.env.setup.local` at the repository root: ignored by git (`.env.*`), outside both Vercel
// project folders so no deploy uploads it, and readable by the owner only.
function savedPath(): string {
  return path.join(repoRoot(), ".env.setup.local");
}

export async function readSaved(): Promise<SavedSetup & { saved: boolean }> {
  try {
    return { ...parseSetup(await readFile(savedPath(), "utf8")), saved: true };
  } catch {
    return { ...EMPTY_SETUP, saved: false };
  }
}

export async function writeSaved(setup: SavedSetup): Promise<void> {
  const file = savedPath();
  await writeFile(file, serializeSetup(setup), { mode: 0o600 });
  // `mode` only applies when the file is created; an existing file keeps its old permissions.
  await chmod(file, 0o600);
}

export async function forgetSaved(): Promise<void> {
  await rm(savedPath(), { force: true });
}

// Production as seen from this machine: the two production addresses (asked of Vercel through
// its CLI, signed in as you), whether each answers, and the latest run of the Deploy workflow.

// The same version as VERCEL_CLI_VERSION in .github/workflows/deploy.yml; change both together.
// Run through npx because `vercel api` needs a newer CLI than many machines have installed.
const VERCEL_CLI = "vercel@63.1.2";

export type Endpoint = { url: string | null; healthy: boolean; detail: string; model?: string };
export type ReleaseRun = {
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  title: string;
};
export type ProductionStatus = {
  linked: boolean;
  web: Endpoint | null;
  agent: Endpoint | null;
  release: ReleaseRun | null;
};

async function readLink(unit: "web" | "agent"): Promise<{ orgId: string; projectId: string } | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(repoRoot(), unit, ".vercel", "project.json"), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { orgId, projectId } = raw as Record<string, unknown>;
    return typeof orgId === "string" && typeof projectId === "string" ? { orgId, projectId } : null;
  } catch {
    return null;
  }
}

async function productionDomain(link: { orgId: string; projectId: string }): Promise<string | null> {
  const team = link.orgId.startsWith("team_") ? `?teamId=${link.orgId}` : "";
  const result = await run(
    "npx",
    ["--yes", VERCEL_CLI, "api", `/v9/projects/${link.projectId}/domains${team}`],
    90_000,
  );
  if (!result.ok) return null;
  try {
    const body: unknown = JSON.parse(result.stdout);
    const domains =
      typeof body === "object" && body !== null && Array.isArray((body as { domains?: unknown }).domains)
        ? ((body as { domains: { name?: unknown }[] }).domains)
        : [];
    const name = domains.find((domain) => typeof domain.name === "string")?.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

async function probe(domain: string | null, healthPath: string): Promise<Endpoint> {
  if (!domain) return { url: null, healthy: false, detail: "Vercel did not report a production address." };
  const url = `https://${domain}`;
  try {
    const response = await fetch(`${url}${healthPath}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { url, healthy: false, detail: `Answers ${response.status}.` };
    const body: unknown = await response.json().catch(() => null);
    const model =
      typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return { url, healthy: true, detail: "Answering.", ...(model ? { model } : {}) };
  } catch {
    return { url, healthy: false, detail: "Does not answer yet." };
  }
}

async function latestRelease(): Promise<ReleaseRun | null> {
  const result = await run("gh", [
    "run", "list", "--workflow", "deploy.yml", "--branch", "main", "--limit", "1",
    "--json", "status,conclusion,url,createdAt,displayTitle",
  ]);
  if (!result.ok) return null;
  try {
    const [latest] = JSON.parse(result.stdout) as {
      status: string;
      conclusion: string;
      url: string;
      createdAt: string;
      displayTitle: string;
    }[];
    if (!latest) return null;
    return {
      status: latest.status,
      conclusion: latest.conclusion || null,
      url: latest.url,
      createdAt: latest.createdAt,
      title: latest.displayTitle,
    };
  } catch {
    return null;
  }
}

export async function productionStatus(): Promise<ProductionStatus> {
  const [webLink, agentLink, release] = await Promise.all([readLink("web"), readLink("agent"), latestRelease()]);
  if (!webLink || !agentLink) return { linked: false, web: null, agent: null, release };
  const [webDomain, agentDomain] = await Promise.all([productionDomain(webLink), productionDomain(agentLink)]);
  const [web, agent] = await Promise.all([probe(webDomain, "/api/health"), probe(agentDomain, "/health")]);
  return { linked: true, web, agent, release };
}
