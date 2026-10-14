import "server-only";

import { execFile, spawn } from "node:child_process";
import path from "node:path";

import type { ConnectAnswers } from "@/lib/connect-answers";
import { type RequestFacts, refuseUnlessLocal } from "@/lib/local-request";

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
