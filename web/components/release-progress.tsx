"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { Runs } from "@/lib/github";
import {
  OUTCOME_META,
  PHASE_TONE,
  type Phase,
  type Release,
  type ReleaseJob,
  RELEASE_JOB,
  type ReleaseRun,
  currentStep,
  duration,
  failedStep,
  notReleasedReason,
} from "@/lib/releases";
import type { Tone } from "@/lib/trace";
import { cn } from "@/lib/utils";

// A workflow run, job by job and step by step, refreshed while it runs. Used by the local Setup
// page (read with `gh`) and Admin › Releases (read with the GitHub App).

const LIVE_MS = 3_000;
const IDLE_MS = 20_000;

const DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/40",
  blue: "bg-progress",
  amber: "bg-attention",
  green: "bg-success",
  red: "bg-danger",
};

const PHASE_LABEL: Record<Phase, string> = {
  waiting: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export function ReleaseProgress({
  endpoint,
  startUrl,
  notConfigured,
}: {
  endpoint: string;
  // Where a POST starts a release; absent when this viewer cannot start one.
  startUrl?: string;
  notConfigured: React.ReactNode;
}) {
  const [data, setData] = useState<Runs | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [start, setStart] = useState<{ kind: "idle" | "starting" } | { kind: "failed"; detail: string }>({ kind: "idle" });
  const [now, setNow] = useState(0);
  // GitHub lists a started run a few seconds after it was asked for: poll fast meanwhile.
  const [justStarted, setJustStarted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const running = data?.ok
    ? data.selected?.outcome === "running" || data.runs.some((run) => run.phase === "running" || run.phase === "waiting")
    : false;
  const live = running || justStarted;

  const load = useCallback(async () => {
    try {
      const url = new URL(endpoint, window.location.origin);
      if (selected) url.searchParams.set("run", String(selected));
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        setFailed(response.status);
        return;
      }
      setData(await response.json());
      setFailed(null);
    } catch {
      setFailed(0);
    }
  }, [endpoint, selected]);

  // Fast while something runs, slow otherwise (a push from someone else starts a run too), and
  // not at all while the tab is hidden.
  useEffect(() => {
    let stopped = false;
    async function tick() {
      if (!document.hidden) await load();
      if (!stopped) timer.current = setTimeout(tick, live ? LIVE_MS : IDLE_MS);
    }
    void tick();
    const wake = () => {
      if (!document.hidden) {
        clearTimeout(timer.current);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [load, live]);

  // A second hand for the durations of what is still running.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    if (!live) return;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [live, data]);

  async function startRelease() {
    if (!startUrl) return;
    setStart({ kind: "starting" });
    try {
      const response = await fetch(startUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body: { detail?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStart({ kind: "failed", detail: body.detail ?? body.error ?? `The request failed (${response.status}).` });
        return;
      }
      setStart({ kind: "idle" });
      setSelected(null);
      setJustStarted(true);
      setTimeout(() => setJustStarted(false), 30_000);
      await load();
    } catch {
      setStart({ kind: "failed", detail: "The server did not answer." });
    }
  }

  return (
    <div className="grid gap-3">
      {startUrl ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={startRelease} disabled={start.kind === "starting" || live}>
            {start.kind === "starting" ? "Starting…" : running ? "A release is running" : justStarted ? "Started" : "Start a release"}
          </Button>
          {start.kind === "failed" ? (
            <span role="alert" className="text-danger">
              {start.detail}
            </span>
          ) : null}
        </div>
      ) : null}

      {failed !== null && !data ? (
        <p className="text-danger">
          Could not read the releases{failed ? ` (the server answered ${failed})` : ""}.
        </p>
      ) : null}
      {data === null && failed === null ? <p className="text-muted-foreground">Asking GitHub…</p> : null}
      {data && !data.ok ? (
        data.reason === "not-configured" ? (
          notConfigured
        ) : (
          <p className="text-danger">
            {data.reason === "refused"
              ? "GitHub refused the request. The token may have expired, or lack read access to this repository's Actions."
              : "GitHub did not answer. Trying again shortly."}
          </p>
        )
      ) : null}

      {data?.ok && !data.selected ? <p className="text-muted-foreground">Nothing has run on main yet.</p> : null}
      {data?.ok && data.selected ? <SelectedRelease release={data.selected} now={now} /> : null}
      {data?.ok && data.runs.length > 1 ? (
        <OlderRuns runs={data.runs} selected={data.selected?.id ?? null} onSelect={setSelected} />
      ) : null}
    </div>
  );
}

function SelectedRelease({ release, now }: { release: Release; now: number }) {
  const meta = OUTCOME_META[release.outcome];
  const where = release.outcome === "running" ? currentStep(release) : release.outcome === "failed" ? failedStep(release) : null;
  const errors = release.jobs.flatMap((job) => job.errors);

  return (
    <div className="grid gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ToneBadge tone={meta.tone} pulse={release.outcome === "running"}>
          {meta.label}
        </ToneBadge>
        <span className="font-medium">{release.title}</span>
        <span className="font-mono text-xs text-muted-foreground">{release.commit}</span>
        <span className="text-xs text-muted-foreground">
          {release.actor ? `${release.actor}, ` : ""}
          <RelativeTime iso={release.createdAt} />
        </span>
        <a href={release.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline underline-offset-2">
          View on GitHub
        </a>
      </div>

      {release.outcome === "running" && where ? <p>Now: {where}</p> : null}
      {release.outcome === "failed" ? (
        <div className="grid gap-1">
          <p className="text-danger">
            Stopped at {where ?? "an unknown step"}. Production keeps the previous version.
          </p>
          {errors.length ? (
            <pre className="overflow-x-auto rounded-md border border-danger-border bg-danger-surface px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-danger">
              {errors.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
      {release.outcome === "not-released" ? (
        <p className="text-muted-foreground">Checks passed; nothing deployed. {notReleasedReason(release)}</p>
      ) : null}
      {release.outcome === "released" ? <p>Live in production.</p> : null}

      <ol className="grid gap-1">
        {release.jobs.map((job) => (
          <JobRow key={job.id} job={job} now={now} />
        ))}
      </ol>
    </div>
  );
}

function JobRow({ job, now }: { job: ReleaseJob; now: number }) {
  // Open what needs looking at; finished checks fold away, the release itself stays open.
  const open = job.phase === "running" || job.phase === "failed" || (job.name === RELEASE_JOB && job.phase !== "skipped");
  return (
    <li>
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted">
          <Dot phase={job.phase} />
          <span className={cn(job.phase === "skipped" && "text-muted-foreground")}>{job.name}</span>
          <span className="text-xs text-muted-foreground">
            {job.phase === "skipped" ? "skipped" : duration(job.startedAt, job.completedAt, now)}
          </span>
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-primary underline underline-offset-2"
          >
            Log
          </a>
        </summary>
        {job.steps.length ? (
          <ol className="mt-1 mb-2 ml-3 grid gap-0.5 border-l pl-3 text-sm">
            {job.steps.map((step, index) => (
              <li key={`${index}-${step.name}`} className="flex items-center gap-2">
                <Dot phase={step.phase} />
                <span className={cn(step.phase === "skipped" || step.phase === "waiting" ? "text-muted-foreground" : null)}>
                  {step.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {step.phase === "skipped" ? "skipped" : duration(step.startedAt, step.completedAt, now)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </details>
    </li>
  );
}

function OlderRuns({
  runs,
  selected,
  onSelect,
}: {
  runs: ReleaseRun[];
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <p className="text-xs text-muted-foreground">Recent runs on main</p>
      <ul className="grid gap-0.5">
        {runs.map((run, index) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(index === 0 ? null : run.id)}
              aria-current={run.id === selected ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted",
                run.id === selected && "bg-muted",
              )}
            >
              <Dot phase={run.phase} />
              <span className="truncate">{run.title}</span>
              <span className="font-mono text-xs text-muted-foreground">{run.commit}</span>
              {/* The run's result, not whether it deployed: that needs its jobs, read only for the selected run. */}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {run.phase === "succeeded" ? "Passed" : PHASE_LABEL[run.phase]}, <RelativeTime iso={run.createdAt} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dot({ phase }: { phase: Phase }) {
  return (
    <span
      aria-label={PHASE_LABEL[phase]}
      role="img"
      className={cn("size-2 shrink-0 rounded-full", DOT[PHASE_TONE[phase]], phase === "running" && "animate-pulse")}
    />
  );
}
