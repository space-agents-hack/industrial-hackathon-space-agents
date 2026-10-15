// Runs of the Deploy workflow as the app shows them: each job and its steps, live. Pure functions
// over GitHub's REST answers; fetching them is in lib/github.ts.

import type { Tone } from "./trace";

export type Phase = "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export type ReleaseStep = {
  name: string;
  phase: Phase;
  startedAt: string | null;
  completedAt: string | null;
};

export type ReleaseJob = {
  id: number;
  name: string;
  phase: Phase;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: ReleaseStep[];
  // The `::error::` lines the job printed, when GitHub let us read them.
  errors: string[];
};

// What the run means for production, which the run's own result does not say: a green run whose
// release job stopped at "What is configured" deployed nothing.
export type Outcome = "running" | "released" | "checked" | "not-released" | "failed" | "cancelled";

export type ReleaseRun = {
  id: number;
  title: string;
  commit: string;
  branch: string;
  event: string;
  actor: string | null;
  url: string;
  createdAt: string;
  phase: Phase;
};

export type Release = ReleaseRun & { outcome: Outcome; jobs: ReleaseJob[] };

// The workflow's names this file depends on. contract.test.ts checks deploy.yml still has them.
export const RELEASE_JOB = "Release to production";
export const LAST_RELEASE_STEP = "Promote web";

// Steps GitHub adds to every job. They say nothing about this workflow.
const BOILERPLATE = /^(Set up job|Complete job|Post .*)$/;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function phaseOf(status: unknown, conclusion: unknown): Phase {
  if (status !== "completed") return status === "in_progress" ? "running" : "waiting";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "succeeded";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      // failure, timed_out, action_required, startup_failure, stale
      return "failed";
  }
}

export function parseRun(raw: unknown): ReleaseRun | null {
  const run = record(raw);
  if (typeof run.id !== "number") return null;
  return {
    id: run.id,
    title: str(run.display_title) ?? str(run.name) ?? "Deploy",
    commit: (str(run.head_sha) ?? "").slice(0, 7),
    branch: str(run.head_branch) ?? "",
    event: str(run.event) ?? "",
    actor: str(record(run.triggering_actor).login) ?? str(record(run.actor).login),
    url: str(run.html_url) ?? "",
    createdAt: str(run.created_at) ?? "",
    phase: phaseOf(run.status, run.conclusion),
  };
}

export function parseRuns(raw: unknown): ReleaseRun[] {
  const runs = record(raw).workflow_runs;
  return Array.isArray(runs) ? runs.map(parseRun).filter((run) => run !== null) : [];
}

export function parseJobs(raw: unknown): ReleaseJob[] {
  const jobs = record(raw).jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((rawJob) => {
    const job = record(rawJob);
    if (typeof job.id !== "number") return [];
    const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
    return [
      {
        id: job.id,
        name: str(job.name) ?? "Job",
        phase: phaseOf(job.status, job.conclusion),
        url: str(job.html_url) ?? "",
        startedAt: str(job.started_at),
        completedAt: str(job.completed_at),
        steps: steps
          .filter((step) => !BOILERPLATE.test(str(step.name) ?? ""))
          .map((step) => ({
            name: str(step.name) ?? "Step",
            phase: phaseOf(step.status, step.conclusion),
            startedAt: str(step.started_at),
            completedAt: str(step.completed_at),
          })),
        errors: [],
      },
    ];
  });
}

// Why a job failed, from its log. First choice: the `::error::` lines the workflow printed (GitHub
// writes them as `##[error]`). A command that fails without one (a CLI refusing, a test failing)
// leaves only GitHub's "Process completed with exit code N"; then the last lines the step printed
// before it are the reason.
const EXIT_LINE = /^Process completed with exit code \d+\.?$/;

function clean(line: string): string {
  return line
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trimEnd();
}

export function parseErrors(log: string): string[] {
  const lines = log.split("\n").map(clean);
  const errors = lines
    .map((line) => /^##\[error\](.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((message) => message && !EXIT_LINE.test(message));
  if (errors.length) return [...new Set(errors)].slice(0, 3);

  const exit = lines.findIndex((line) => /^##\[error\]/.test(line));
  if (exit < 0) return [];
  return lines
    .slice(0, exit)
    .filter((line) => line.trim() && !line.startsWith("##["))
    .slice(-4);
}

export function outcomeOf(run: ReleaseRun, jobs: ReleaseJob[]): Outcome {
  if (run.phase === "running" || run.phase === "waiting") return "running";
  if (run.phase === "cancelled") return "cancelled";
  if (run.phase === "failed") return "failed";
  const release = jobs.find((job) => job.name === RELEASE_JOB);
  // Pull requests run the checks only.
  if (!release || release.phase === "skipped") return run.event === "pull_request" ? "checked" : "not-released";
  const last = release.steps.find((step) => step.name === LAST_RELEASE_STEP);
  return last?.phase === "succeeded" ? "released" : "not-released";
}

export function toRelease(run: ReleaseRun, jobs: ReleaseJob[]): Release {
  return { ...run, outcome: outcomeOf(run, jobs), jobs };
}

// "Check web › Build; Check agent › Tests": what is happening now, for the one-line summary. The
// checks run in parallel, so there can be several.
export function currentStep(release: Release): string | null {
  const now = release.jobs
    .filter((job) => job.phase === "running")
    .map((job) => {
      const step = job.steps.find((s) => s.phase === "running");
      return step ? `${job.name} › ${step.name}` : job.name;
    });
  if (now.length) return now.join("; ");
  return release.jobs.some((job) => job.phase === "waiting") ? "Waiting for a runner" : null;
}

// Where it stopped: the first failed step of the first failed job.
export function failedStep(release: Release): string | null {
  const job = release.jobs.find((j) => j.phase === "failed");
  if (!job) return null;
  const step = job.steps.find((s) => s.phase === "failed");
  return step ? `${job.name} › ${step.name}` : job.name;
}

// Why a green run deployed nothing, read from the steps that did run.
export function notReleasedReason(release: Release): string {
  const job = release.jobs.find((j) => j.name === RELEASE_JOB);
  if (!job || job.phase === "skipped") return "The release job did not run.";
  const ran = job.steps.filter((s) => s.phase !== "skipped").map((s) => s.name);
  if (!ran.includes("Is this commit still the head of main")) {
    return "Production is not configured yet; the first step of the release job says what is missing.";
  }
  if (!ran.includes("Apply migrations") && !ran.includes("Deploy agent (not yet live)")) {
    return "A newer commit was pushed; its own run releases it.";
  }
  return "The release stopped before promoting the web.";
}

export const OUTCOME_META: Record<Outcome, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "blue" },
  released: { label: "Released", tone: "green" },
  checked: { label: "Checks passed", tone: "green" },
  "not-released": { label: "Not released", tone: "neutral" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const PHASE_TONE: Record<Phase, Tone> = {
  waiting: "neutral",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
  skipped: "neutral",
};

// "1m 05s" from two timestamps; `now` for something still running.
export function duration(startedAt: string | null, completedAt: string | null, now: number): string {
  if (!startedAt) return "";
  const end = completedAt ? Date.parse(completedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (Number.isNaN(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}
