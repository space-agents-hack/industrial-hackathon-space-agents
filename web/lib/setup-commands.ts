import "server-only";

import { execFile, spawn } from "node:child_process";
import path from "node:path";

import { type RequestFacts, refuseUnlessLocal } from "@/lib/local-request";
import type { CreatedApp } from "@/lib/github-app";
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

// Like runCli, with `input` on standard input: how secrets reach `gh`, never as an argument.
export function runCliInput(command: string, args: string[], input: string, timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot(), env: childEnv() as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim() });
    });
    child.stdin.end(input);
  });
}

// ------------------------------------------------------------------ the GitHub App (ADR-0005)

export type RepoInfo = { fullName: string; name: string; id: number; ownerLogin: string; ownerId: number; ownerType: string };

export async function repoInfo(): Promise<RepoInfo | null> {
  const result = await runCli("gh", ["api", "repos/{owner}/{repo}"]);
  if (!result.ok) return null;
  try {
    const repo = JSON.parse(result.stdout) as {
      full_name: string;
      name: string;
      id: number;
      owner: { login: string; id: number; type: string };
    };
    return {
      fullName: repo.full_name,
      name: repo.name,
      id: repo.id,
      ownerLogin: repo.owner.login,
      ownerId: repo.owner.id,
      ownerType: repo.owner.type,
    };
  } catch {
    return null;
  }
}

// The production environment, created with the rule that only main may use it if it does not
// exist yet. Creating it needs Administration, which your `gh` has and the app deliberately lacks.
async function ensureProductionEnvironment(repo: string): Promise<boolean> {
  if ((await runCli("gh", ["api", `repos/${repo}/environments/production`])).ok) return true;
  const created = await runCliInput(
    "gh",
    ["api", "-X", "PUT", `repos/${repo}/environments/production`, "--input", "-"],
    JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
  );
  if (!created.ok) return false;
  await runCli("gh", ["api", "-X", "POST", `repos/${repo}/environments/production/deployment-branch-policies`, "-f", "name=main", "-f", "type=branch"]);
  return true;
}

// The app's ID and key go into GitHub, from where the next release copies them to the web
// (deploy.yml, "Carry settings to Vercel"). Nothing is kept on this machine. The key is stored
// base64-encoded on one line, so no tool on the way has to keep a PEM's line breaks.
export async function storeGithubApp(app: CreatedApp, repo: string, settingsUrl: string): Promise<boolean> {
  if (!(await ensureProductionEnvironment(repo))) return false;
  const secret = (name: string, value: string) =>
    runCliInput("gh", ["secret", "set", name, "--env", "production", "--repo", repo], value);
  const id = await secret("GH_APP_ID", String(app.id));
  const key = await secret("GH_APP_PRIVATE_KEY_B64", Buffer.from(app.pem).toString("base64"));
  const slug = await runCli("gh", ["variable", "set", "GH_APP_SLUG", "--repo", repo, "--body", app.slug]);
  await runCli("gh", ["variable", "set", "GH_APP_SETTINGS_URL", "--repo", repo, "--body", settingsUrl]);
  // A new app is not installed anywhere yet.
  await runCli("gh", ["variable", "delete", "GH_APP_INSTALLATION_ID", "--repo", repo]);
  return id.ok && key.ok && slug.ok;
}

export async function recordInstallation(installationId: number, repo: string): Promise<boolean> {
  const set = await runCli("gh", ["variable", "set", "GH_APP_INSTALLATION_ID", "--repo", repo, "--body", String(installationId)]);
  return set.ok;
}

// The app this repository's setup created, from the variables above. Names only.
export type GithubAppStatus = { slug: string; installed: boolean; settingsUrl: string | null };

export async function githubAppStatus(): Promise<GithubAppStatus | null> {
  const listed = await runCli("gh", ["variable", "list", "--json", "name,value"]);
  if (!listed.ok) return null;
  try {
    const variables = new Map((JSON.parse(listed.stdout) as { name: string; value: string }[]).map((v) => [v.name, v.value]));
    const slug = variables.get("GH_APP_SLUG");
    // Rendered as a link: only ever a GitHub address.
    const settings = variables.get("GH_APP_SETTINGS_URL") ?? "";
    return slug
      ? { slug, installed: Boolean(variables.get("GH_APP_INSTALLATION_ID")), settingsUrl: settings.startsWith("https://github.com/") ? settings : null }
      : null;
  } catch {
    return null;
  }
}

// The Supabase project setup used last time, if any (scripts/bootstrap.sh sets the variable).
export async function knownProjectRef(): Promise<string | null> {
  const result = await runCli("gh", ["api", "repos/{owner}/{repo}/actions/variables/SUPABASE_PROJECT_REF", "--jq", ".value"]);
  return result.ok && /^[a-z0-9]{20}$/.test(result.stdout) ? result.stdout : null;
}

// Records the installation (it ticks the Setup step; production finds the installation itself with
// the app's key) and, on a deployment that already exists, starts the release that gives the web
// the key. Only for an app this page created.
// "started": a release is giving the web the key; "later": production does not exist yet, and Create
// production's release will; "failed": it exists but the release did not start.
export type InstallRelease = "started" | "later" | "failed";

export async function finishInstallation(installationId: number): Promise<{ ok: boolean; release: InstallRelease }> {
  const [repo, app] = await Promise.all([repoInfo(), githubAppStatus()]);
  if (!repo || !app || !(await recordInstallation(installationId, repo.fullName))) return { ok: false, release: "later" };
  return { ok: true, release: await releaseWithSettings(repo.fullName) };
}

async function releaseWithSettings(repo: string): Promise<InstallRelease> {
  const secrets = await runCli("gh", ["api", `repos/${repo}/environments/production/secrets`, "--jq", ".secrets[].name"]);
  if (!secrets.ok || !secrets.stdout.split("\n").includes("VERCEL_WEB_PROJECT_ID")) return "later";
  return (await runCli("gh", ["workflow", "run", "deploy.yml", "--repo", repo, "--ref", "main"])).ok ? "started" : "failed";
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
