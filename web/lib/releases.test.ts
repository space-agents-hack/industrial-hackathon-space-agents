import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentStep,
  duration,
  failedStep,
  notReleasedReason,
  parseErrors,
  parseJobs,
  parseRuns,
  toRelease,
} from "./releases.ts";

const run = (over: Record<string, unknown> = {}) => ({
  id: 1,
  display_title: "Fix the trace",
  head_sha: "0123456789abcdef",
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/1",
  created_at: "2026-10-15T08:00:00Z",
  actor: { login: "clemenjuan" },
  ...over,
});

const step = (name: string, status = "completed", conclusion: string | null = "success") => ({
  name,
  status,
  conclusion,
  started_at: "2026-10-15T08:00:00Z",
  completed_at: status === "completed" ? "2026-10-15T08:00:05Z" : null,
});

const job = (name: string, steps: ReturnType<typeof step>[], status = "completed", conclusion: string | null = "success") => ({
  id: name.length,
  name,
  status,
  conclusion,
  html_url: "https://github.com/o/r/actions/runs/1/job/2",
  started_at: "2026-10-15T08:00:00Z",
  completed_at: null,
  steps,
});

const releaseSteps = (last: string | null, conclusion: string) => [
  step("Set up job"),
  step("What is configured"),
  step("Is this commit still the head of main"),
  step("Apply migrations"),
  step("Deploy agent (not yet live)"),
  step("Promote web", "completed", last ?? conclusion),
  step("Post Run actions/checkout@v7"),
  step("Complete job"),
];

test("runs are read from GitHub's list, short sha and who started it", () => {
  const [parsed] = parseRuns({ workflow_runs: [run({ triggering_actor: { login: "rgalarcia" } })] });
  assert.equal(parsed.commit, "0123456");
  assert.equal(parsed.actor, "rgalarcia");
  assert.equal(parsed.phase, "succeeded");
  assert.deepEqual(parseRuns({ message: "Bad credentials" }), []);
});

test("GitHub's own steps are hidden", () => {
  const [parsed] = parseJobs({ jobs: [job(RELEASE, releaseSteps(null, "success"))] });
  assert.deepEqual(
    parsed.steps.map((s) => s.name),
    ["What is configured", "Is this commit still the head of main", "Apply migrations", "Deploy agent (not yet live)", "Promote web"],
  );
});

const RELEASE = "Release to production";

function release(runOver: Record<string, unknown>, jobs: ReturnType<typeof job>[]) {
  const [parsed] = parseRuns({ workflow_runs: [run(runOver)] });
  return toRelease(parsed, parseJobs({ jobs }));
}

test("a green run is released only when the web was promoted", () => {
  assert.equal(release({}, [job(RELEASE, releaseSteps(null, "success"))]).outcome, "released");

  const notConfigured = release({}, [
    job(RELEASE, [step("What is configured"), step("Is this commit still the head of main", "completed", "skipped"), step("Promote web", "completed", "skipped")]),
  ]);
  assert.equal(notConfigured.outcome, "not-released");
  assert.match(notReleasedReason(notConfigured), /not configured/);

  const superseded = release({}, [
    job(RELEASE, [step("What is configured"), step("Is this commit still the head of main"), step("Apply migrations", "completed", "skipped"), step("Deploy agent (not yet live)", "completed", "skipped"), step("Promote web", "completed", "skipped")]),
  ]);
  assert.match(notReleasedReason(superseded), /newer commit/);
});

test("a finished Bootstrap run is done, not released", () => {
  const [parsed] = parseRuns({ workflow_runs: [run({ display_title: "Bootstrap" })] });
  assert.equal(toRelease(parsed, parseJobs({ jobs: [job("Connect Vercel and Supabase", [step("Connect")])] }), "bootstrap.yml").outcome, "done");
});

test("pull requests only check", () => {
  const pr = release({ event: "pull_request" }, [job("Check web (Next.js)", [step("Build")]), job(RELEASE, [], "completed", "skipped")]);
  assert.equal(pr.outcome, "checked");
});

test("a running release says which step it is on", () => {
  const live = release({ status: "in_progress", conclusion: null }, [
    job("Check web (Next.js)", [step("Build")]),
    job(RELEASE, [step("What is configured"), step("Smoke web", "in_progress", null), step("Promote web", "queued", null)], "in_progress", null),
  ]);
  assert.equal(live.outcome, "running");
  assert.equal(currentStep(live), "Release to production › Smoke web");

  const checks = release({ status: "in_progress", conclusion: null }, [
    job("Check web (Next.js)", [step("Build", "in_progress", null)], "in_progress", null),
    job("Check agent (Python)", [step("Tests", "in_progress", null)], "in_progress", null),
  ]);
  assert.equal(currentStep(checks), "Check web (Next.js) › Build; Check agent (Python) › Tests");
});

test("a failed release names the step where it stopped", () => {
  const failed = release({ conclusion: "failure" }, [
    job(RELEASE, [step("What is configured"), step("Smoke web", "completed", "failure"), step("Promote web", "completed", "skipped")], "completed", "failure"),
  ]);
  assert.equal(failed.outcome, "failed");
  assert.equal(failedStep(failed), "Release to production › Smoke web");
});

test("only the workflow's own error lines are kept", () => {
  const log = [
    "2026-10-15T08:00:01.0Z Run vercel curl /api/health/deep",
    "2026-10-15T08:00:02.0Z ##[error]The deep health check failed (see the line above). Not promoted.",
    "2026-10-15T08:00:02.1Z ##[error]Process completed with exit code 1.",
    "2026-10-15T08:00:02.2Z ##[warning]Supabase secrets are not set",
  ].join("\n");
  assert.deepEqual(parseErrors(log), ["The deep health check failed (see the line above). Not promoted."]);
  assert.deepEqual(parseErrors(""), []);
});

test("without an error line, the step's last output is the reason", () => {
  const log = [
    "2026-10-15T08:00:01.0Z ##[group]Run vercel deploy",
    "2026-10-15T08:00:02.0Z \u001b[36;1mBuilding\u001b[0m",
    "2026-10-15T08:00:03.0Z error: Required uv version `>=0.13` does not match the running version `0.10.11`.",
    "2026-10-15T08:00:03.1Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  assert.deepEqual(parseErrors(log), [
    "Building",
    "error: Required uv version `>=0.13` does not match the running version `0.10.11`.",
  ]);
});

test("durations read like a stopwatch", () => {
  const now = Date.parse("2026-10-15T08:01:05Z");
  assert.equal(duration("2026-10-15T08:00:00Z", null, now), "1m 05s");
  assert.equal(duration("2026-10-15T08:00:00Z", "2026-10-15T08:00:09Z", now), "9s");
  assert.equal(duration(null, null, now), "");
});
