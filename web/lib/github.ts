import "server-only";

import { runCli } from "@/lib/setup-commands";
import { type Release, type ReleaseRun, parseErrors, parseJobs, parseRuns, toRelease } from "@/lib/releases";

// Reads the Deploy workflow's runs from GitHub, for the Setup page and for Admin › Releases.
//
// Two ways in, and only reading: on `make dev`, the `gh` CLI you are signed in with; in
// production, a fine-grained token limited to this repository's Actions (read-only), in
// RELEASES_GITHUB_TOKEN on the web's Vercel project. That token can see runs and logs; it cannot
// start, cancel or change anything. Starting a release from production is a separate decision
// (TODO.md): it needs a token that can.

export type Releases =
  | { ok: true; runs: ReleaseRun[]; selected: Release | null }
  | { ok: false; reason: "not-configured" | "refused" | "unreachable" };

type Answer = { ok: true; data: unknown } | { ok: false; reason: "refused" | "unreachable" };
type Get = (path: string, as?: "json" | "text") => Promise<Answer>;

const API = "https://api.github.com";

// `{owner}/{repo}` is filled in by `gh` from the checkout, and from RELEASES_GITHUB_REPO here.
function source(): Get | null {
  const token = process.env.RELEASES_GITHUB_TOKEN;
  const repo = process.env.RELEASES_GITHUB_REPO;
  if (token && repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return async (path, as = "json") => {
      try {
        const response = await fetch(`${API}/${path.replace("{owner}/{repo}", repo)}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { ok: false, reason: response.status >= 500 ? "unreachable" : "refused" };
        return { ok: true, data: as === "text" ? await response.text() : await response.json() };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    };
  }
  // Only the dev server `make dev` starts (scripts/dev.mjs): never a deployment, never `next start`.
  if (process.env.SETUP_LOOPBACK_ONLY === "1" && !process.env.VERCEL) {
    return async (path, as = "json") => {
      const result = await runCli("gh", ["api", path]);
      if (!result.ok) return { ok: false, reason: "refused" };
      if (as === "text") return { ok: true, data: result.stdout };
      try {
        return { ok: true, data: JSON.parse(result.stdout) };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    };
  }
  return null;
}

// A page left open polls every few seconds, and so may a second person. GitHub allows a token
// 5,000 requests an hour; one answer per path every few seconds keeps several viewers far below.
const FRESH_MS = 3_000;
const recent = new Map<string, { at: number; answer: Promise<Answer> }>();

function cached(get: Get, path: string): Promise<Answer> {
  const now = Date.now();
  const hit = recent.get(path);
  if (hit && now - hit.at < FRESH_MS) return hit.answer;
  for (const [key, entry] of recent) if (now - entry.at >= FRESH_MS) recent.delete(key);
  const answer = get(path);
  recent.set(path, { at: now, answer });
  return answer;
}

// The latest runs on main, and one of them (the newest unless `runId` says otherwise) with every
// job and step. Pull request runs are left out: they never release.
export async function readReleases(runId?: number): Promise<Releases> {
  const get = source();
  if (!get) return { ok: false, reason: "not-configured" };

  const listed = await cached(get, "repos/{owner}/{repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=8");
  if (!listed.ok) return listed;
  const runs = parseRuns(listed.data).filter((run) => run.event !== "pull_request");
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  if (!run) return { ok: true, runs, selected: null };

  const jobsAnswer = await cached(get, `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=50`);
  const jobs = jobsAnswer.ok ? parseJobs(jobsAnswer.data) : [];

  // Why a job failed is in its log, which can be megabytes: read once per failed job and kept,
  // since a finished job's log does not change.
  await Promise.all(
    jobs
      .filter((job) => job.phase === "failed")
      .map(async (job) => {
        job.errors = await jobErrors(get, job.id);
      }),
  );

  return { ok: true, runs, selected: toRelease(run, jobs) };
}

const errorsByJob = new Map<number, string[]>();

async function jobErrors(get: Get, jobId: number): Promise<string[]> {
  const known = errorsByJob.get(jobId);
  if (known) return known;
  const log = await get(`repos/{owner}/{repo}/actions/jobs/${jobId}/logs`, "text");
  if (!log.ok || typeof log.data !== "string") return [];
  const errors = parseErrors(log.data);
  if (errorsByJob.size > 100) errorsByJob.clear();
  errorsByJob.set(jobId, errors);
  return errors;
}

export function parseRunId(value: string | null): number | undefined {
  return value && /^\d{1,20}$/.test(value) ? Number(value) : undefined;
}
