import "server-only";

import { randomBytes } from "node:crypto";

import { type DeploymentChange, ENVIRONMENT, type SecretName } from "@/lib/deployment";
import { appJwt, decodePrivateKey } from "@/lib/github-app-jwt";
import { type Release, type ReleaseRun, parseErrors, parseJobs, parseRuns, toRelease } from "@/lib/releases";
import { sealForGitHub } from "@/lib/sealed-box";
import { runCli } from "@/lib/setup-commands";

// The app's one door to GitHub: the workflows' runs (Admin › Releases, the Setup page) and the
// values the workflows read (Admin › Deployment). ADR-0005 says why GitHub, and why the
// Vercel and Supabase tokens are never in the app.
//
// Two ways in. In production, the GitHub App the Setup page created for this repository
// (GH_APP_ID and GH_APP_PRIVATE_KEY_B64 on the web's Vercel project): its key mints
// one-hour tokens limited to the app's permissions on this one repository, which can write a secret
// but never read one back, and start workflows. Or, on `make dev` only, the `gh` CLI you are signed
// in with, for reading.

type Answer =
  | { ok: true; status: number; data: unknown }
  | { ok: false; reason: "refused" | "unreachable"; status?: number; detail?: string };

type Method = "GET" | "POST" | "PUT" | "PATCH";

const API = "https://api.github.com";

// Fixed at build time (next.config.ts): the repository whose workflow built this deployment.
function repoName(): string | null {
  const repo = process.env.GITHUB_REPO;
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function appCredentials(): { id: string; key: string } | null {
  const id = process.env.GH_APP_ID;
  const key = process.env.GH_APP_PRIVATE_KEY_B64;
  return id && key ? { id, key } : null;
}

// One installation token at a time, reused until five minutes before it expires; concurrent
// requests share the same exchange instead of each asking GitHub.
let installation: { token: string; expiresAt: number } | null = null;
let installationId: number | null = null;
let pending: Promise<string | null> | null = null;

async function installationToken(): Promise<string | null> {
  const app = appCredentials();
  const repo = repoName();
  if (!app || !repo) return null;
  if (installation && installation.expiresAt - Date.now() > 5 * 60_000) return installation.token;
  pending ??= (async () => {
    try {
      const jwt = appJwt(app.id, decodePrivateKey(app.key), Math.floor(Date.now() / 1000));
      const headers = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      };
      if (installationId === null) {
        const found = await fetch(`${API}/repos/${repo}/installation`, { headers, cache: "no-store" });
        if (!found.ok) return null;
        installationId = Number(((await found.json()) as { id?: unknown }).id) || null;
        if (installationId === null) return null;
      }
      const minted = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers,
        cache: "no-store",
      });
      if (!minted.ok) {
        // Uninstalled and installed again gets a new id: look it up next time.
        if (minted.status === 404) installationId = null;
        return null;
      }
      const body = (await minted.json()) as { token?: string; expires_at?: string };
      if (!body.token) return null;
      installation = { token: body.token, expiresAt: Date.parse(body.expires_at ?? "") || Date.now() + 50 * 60_000 };
      return body.token;
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

function onMakeDev(): boolean {
  return process.env.SETUP_LOOPBACK_ONLY === "1" && !process.env.VERCEL;
}

export function canRead(): boolean {
  return Boolean((appCredentials() && repoName()) || onMakeDev());
}

export function canWrite(): boolean {
  return Boolean(appCredentials() && repoName());
}

// GitHub says which permission was missing in a header; that sentence is what the person needs.
async function refusal(response: Response): Promise<Answer> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `GitHub answered ${response.status}`;
  const needed = response.headers.get("x-accepted-github-permissions");
  return {
    ok: false,
    reason: response.status >= 500 ? "unreachable" : "refused",
    status: response.status,
    detail: needed ? `${message}. The token needs: ${needed.replaceAll(";", ", ")}.` : `${message}.`,
  };
}

// `{owner}/{repo}` in a path is this repository.
async function api(method: Method, path: string, body?: unknown, as: "json" | "text" = "json"): Promise<Answer> {
  const repo = repoName();
  if (appCredentials() && repo) {
    const token = await installationToken();
    if (!token) {
      return { ok: false, reason: "refused", detail: "The GitHub App could not get a token: is it still installed on this repository?" };
    }
    try {
      const response = await fetch(`${API}/${path.replace("{owner}/{repo}", repo)}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      // A token GitHub no longer accepts (the app was reinstalled, or the key rotated): forget it
      // and the installation, so the next request mints a fresh one instead of failing for an hour.
      if (response.status === 401) {
        installation = null;
        installationId = null;
      }
      if (!response.ok) return refusal(response);
      if (response.status === 204) return { ok: true, status: 204, data: null };
      return { ok: true, status: response.status, data: as === "text" ? await response.text() : await response.json() };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
  // Reading only: changing the deployment from a laptop is what this replaced.
  if (onMakeDev() && method === "GET") {
    const result = await runCli("gh", ["api", path]);
    if (!result.ok) return { ok: false, reason: "refused" };
    if (as === "text") return { ok: true, status: 200, data: result.stdout };
    try {
      return { ok: true, status: 200, data: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
  return { ok: false, reason: "refused", detail: "The GitHub App is not connected." };
}

// A page left open polls every few seconds, and so may a second person. GitHub allows a token
// 5,000 requests an hour; one answer per path every few seconds keeps several viewers far below.
const FRESH_MS = 3_000;
const recent = new Map<string, { at: number; answer: Promise<Answer> }>();

function cachedGet(path: string, as: "json" | "text" = "json"): Promise<Answer> {
  const now = Date.now();
  const hit = recent.get(path);
  if (hit && now - hit.at < FRESH_MS) return hit.answer;
  for (const [key, entry] of recent) if (now - entry.at >= FRESH_MS) recent.delete(key);
  const answer = api("GET", path, undefined, as);
  recent.set(path, { at: now, answer });
  return answer;
}

// ------------------------------------------------------------------------------- reading runs

export type Runs =
  | { ok: true; runs: ReleaseRun[]; selected: Release | null }
  | { ok: false; reason: "not-configured" | "refused" | "unreachable" };

// The latest runs of the Deploy workflow on main, and one of them (the newest unless `runId` says
// otherwise) with every job and step. Pull request runs are left out: they never release.
export async function readRuns(runId?: number): Promise<Runs> {
  if (!canRead()) return { ok: false, reason: "not-configured" };

  const listed = await cachedGet("repos/{owner}/{repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=8");
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const runs = parseRuns(listed.data).filter((run) => run.event !== "pull_request");
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  if (!run) return { ok: true, runs, selected: null };

  const jobsAnswer = await cachedGet(`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=50`);
  const jobs = jobsAnswer.ok ? parseJobs(jobsAnswer.data) : [];

  // Why a job failed is in its log, which can be megabytes: read once per failed job and kept,
  // since a finished job's log does not change.
  await Promise.all(
    jobs
      .filter((job) => job.phase === "failed")
      .map(async (job) => {
        job.errors = await jobErrors(job.id);
      }),
  );

  return { ok: true, runs, selected: toRelease(run, jobs) };
}

const errorsByJob = new Map<number, string[]>();

async function jobErrors(jobId: number): Promise<string[]> {
  const known = errorsByJob.get(jobId);
  if (known) return known;
  const log = await api("GET", `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`, undefined, "text");
  if (!log.ok || typeof log.data !== "string") return [];
  const errors = parseErrors(log.data);
  if (errorsByJob.size > 100) errorsByJob.clear();
  errorsByJob.set(jobId, errors);
  return errors;
}

export function parseRunId(value: string | null): number | undefined {
  return value && /^\d{1,20}$/.test(value) ? Number(value) : undefined;
}

// ------------------------------------------------------------------------ the deployment values

export type StoredSecret = { name: string; updatedAt: string };

export type DeploymentState =
  | { ok: true; repo: string | null; writable: boolean; secrets: StoredSecret[]; model: string | null }
  | { ok: false; repo: string | null; reason: "not-configured" | "refused" | "unreachable"; detail?: string };

// Names and dates only: GitHub has no way to read a secret's value back, and neither has this.
export async function deploymentState(): Promise<DeploymentState> {
  const repo = repoName();
  if (!canRead()) return { ok: false, repo, reason: "not-configured" };
  const [secrets, model] = await Promise.all([
    api("GET", `repos/{owner}/{repo}/environments/${ENVIRONMENT}/secrets?per_page=100`),
    api("GET", "repos/{owner}/{repo}/actions/variables/AGENT_MODEL"),
  ]);
  if (!secrets.ok) {
    // A repository whose Deploy workflow never ran has no production environment yet.
    if (secrets.status === 404) return { ok: true, repo, writable: canWrite(), secrets: [], model: null };
    return { ok: false, repo, reason: secrets.reason, detail: secrets.detail };
  }
  const list = (secrets.data as { secrets?: { name?: unknown; updated_at?: unknown }[] }).secrets ?? [];
  return {
    ok: true,
    repo,
    writable: canWrite(),
    secrets: list
      .filter((s) => typeof s.name === "string")
      .map((s) => ({ name: String(s.name), updatedAt: typeof s.updated_at === "string" ? s.updated_at : "" })),
    model: model.ok ? String((model.data as { value?: unknown }).value ?? "") || null : null,
  };
}

export type Saved = { ok: true; names: string[] } | { ok: false; error: string; names: string[] };

// Writes what changed into the production environment. Each secret is sealed to the
// environment's public key here; only GitHub's runners can open it. Stops at the first refusal
// and says what had already been saved.
export async function saveDeployment(change: DeploymentChange): Promise<Saved> {
  const names: string[] = [];
  if (!canWrite()) return { ok: false, error: "The GitHub App is not connected.", names };

  const values: [string, string][] = Object.entries(change.secrets) as [SecretName, string][];
  if (change.renewSharedSecret) values.push(["AGENT_SHARED_SECRET", randomBytes(32).toString("hex")]);

  if (values.length) {
    const key = await api("GET", `repos/{owner}/{repo}/environments/${ENVIRONMENT}/secrets/public-key`);
    if (!key.ok) {
      return {
        ok: false,
        names,
        error:
          key.status === 404
            ? `The ${ENVIRONMENT} environment does not exist yet. Push once (the Deploy workflow creates it), then save again.`
            : `GitHub refused to give the environment's key. ${key.detail ?? ""}`,
      };
    }
    const { key: publicKey, key_id } = key.data as { key: string; key_id: string };
    for (const [name, value] of values) {
      const put = await api("PUT", `repos/{owner}/{repo}/environments/${ENVIRONMENT}/secrets/${name}`, {
        encrypted_value: sealForGitHub(value, publicKey),
        key_id,
      });
      if (!put.ok) return { ok: false, names, error: `GitHub refused ${name}. ${put.detail ?? ""}` };
      names.push(name);
    }
  }

  if (change.agentModel) {
    const body = { name: "AGENT_MODEL", value: change.agentModel };
    let set = await api("PATCH", "repos/{owner}/{repo}/actions/variables/AGENT_MODEL", body);
    if (!set.ok && set.status === 404) set = await api("POST", "repos/{owner}/{repo}/actions/variables", body);
    if (!set.ok) return { ok: false, names, error: `GitHub refused the model. ${set.detail ?? ""}` };
    names.push("AGENT_MODEL");
  }
  return { ok: true, names };
}

// Workflow inputs are strings, booleans included.
export async function dispatchRelease(inputs: Record<string, string> = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canWrite()) return { ok: false, error: "The GitHub App is not connected." };
  const started = await api("POST", "repos/{owner}/{repo}/actions/workflows/deploy.yml/dispatches", { ref: "main", inputs });
  if (!started.ok) return { ok: false, error: `GitHub refused to start a release. ${started.detail ?? ""}` };
  recent.clear();
  return { ok: true };
}
