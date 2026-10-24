"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApprovalCard } from "@/components/approval-card";
import { CertivityChecks } from "@/components/certivity-checks";
import { RelativeTime } from "@/components/relative-time";
import { RunClock } from "@/components/run-clock";
import { RunResult } from "@/components/run-result";
import { StatusBadge } from "@/components/status-badge";
import { StoredSubmission } from "@/components/stored-submission";
import { Timeline } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { SCRIPTED_MODEL } from "@/lib/admin";
import { looksLikeSubmission } from "@/lib/certivity";
import { fetchApprovals, fetchRun, fetchRunEvents } from "@/lib/runs";
import { createClient } from "@/lib/supabase/client";
import {
  type ApprovalRow,
  type RunEventRow,
  type RunRow,
  buildTimeline,
  canRetry,
  describeActivity,
  formatUsage,
  isApprovalRow,
  isFinished,
  isRunEventRow,
  isRunRow,
  isStalled,
  mergeEvents,
  statusLabel,
  pendingApprovals,
  upsertById,
} from "@/lib/trace";
import type { Decision } from "@/lib/validation";

type Connection = "connecting" | "live" | "offline";

// Each subscription gets its own topic. Leaving a channel is asynchronous, and asking for the
// same topic while the old one is still leaving hands back the old, already-subscribed channel.
let subscriptions = 0;

export function RunTrace({
  initialRun,
  initialEvents,
  initialApprovals,
  agentUnreachable,
  canAct,
}: {
  initialRun: RunRow;
  initialEvents: RunEventRow[];
  initialApprovals: ApprovalRow[];
  agentUnreachable: boolean;
  // Admin or member of the run's organisation. A viewer sees the same page without the buttons;
  // the database and the route handlers refuse their decisions anyway.
  canAct: boolean;
}) {
  const runId = initialRun.id;
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState<readonly RunEventRow[]>(initialEvents);
  const [approvals, setApprovals] = useState<readonly ApprovalRow[]>(initialApprovals);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Re-evaluated on a timer: a run goes stale by time passing, with no event to trigger a render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [run.status]);
  // Set by the effect below; lets the action handlers ask for a fresh read of all three tables.
  const refetch = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;

    async function readAll() {
      try {
        const [freshRun, freshEvents, freshApprovals] = await Promise.all([
          fetchRun(supabase, runId),
          fetchRunEvents(supabase, runId),
          fetchApprovals(supabase, runId),
        ]);
        if (cancelled) return;
        if (freshRun) setRun(freshRun);
        setEvents((current) => mergeEvents(current, freshEvents));
        setApprovals((current) => upsertById(current, freshApprovals));
      } catch (error) {
        console.error("Run trace: refetch failed", error);
      }
    }
    refetch.current = readAll;

    async function subscribe() {
      // The socket must carry the user's token before the channel joins; a channel joined
      // without it is subject to RLS as an anonymous user and receives nothing.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`run:${runId}:${++subscriptions}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "run_events", filter: `run_id=eq.${runId}` },
          (change) => {
            const row = change.new;
            if (isRunEventRow(row)) setEvents((current) => mergeEvents(current, [row]));
            else void readAll();
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "approvals", filter: `run_id=eq.${runId}` },
          (change) => {
            if (change.eventType === "DELETE") return;
            const row = change.new;
            if (isApprovalRow(row)) setApprovals((current) => upsertById(current, [row]));
            else void readAll();
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "runs", filter: `id=eq.${runId}` },
          (change) => {
            const row = change.new;
            if (isRunRow(row)) setRun(row);
            else void readAll();
          },
        )
        .subscribe((state) => {
          if (cancelled) return;
          if (state === "SUBSCRIBED") {
            setConnection("live");
            // Anything written between the server render and this moment was never announced.
            // Reading once more after the subscription is active closes that gap, and does the
            // same after every reconnect.
            void readAll();
          } else {
            setConnection("offline");
          }
        });
    }

    function onVisible() {
      if (document.visibilityState === "visible") void readAll();
    }

    void subscribe();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [runId]);

  const decide = useCallback(
    async (approvalId: string, decision: Decision, note: string) => {
      setNotice(null);
      try {
        const response = await fetch(`/api/approvals/${approvalId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, note }),
        });
        const body: { warning?: string; error?: string } = await response.json().catch(() => ({}));
        if (response.ok) {
          // Do not wait for Realtime to take the card away.
          setApprovals((current) =>
            current.map((approval) =>
              approval.id === approvalId ? { ...approval, status: decision } : approval,
            ),
          );
          if (body.warning) setNotice(`The decision was saved, but the run did not resume. ${body.warning}`);
        } else {
          setNotice(body.error ?? `The decision could not be saved (${response.status}).`);
        }
      } catch {
        setNotice("The decision could not be sent: the server did not answer.");
      }
      await refetch.current?.();
    },
    [],
  );

  const stalled = isStalled(run.status, run.updated_at, now);

  async function retry() {
    setRetrying(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/runs/${runId}/advance`, { method: "POST" });
      // For a stalled run a 409 is the expected answer: the agent refuses to continue it and
      // marks it failed, and the reason arrives with the run itself.
      if (!response.ok && !(stalled && response.status === 409)) {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setNotice(body.error ?? `The agent call failed (${response.status}).`);
      }
    } catch {
      setNotice("The agent call could not be sent: the server did not answer.");
    }
    await refetch.current?.();
    setRetrying(false);
  }

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const pending = pendingApprovals(approvals);
  const finished = isFinished(run.status);
  const usage = formatUsage(run.usage);
  const showRetry = canAct && canRetry(run.status, approvals);

  return (
    <div className="grid gap-4">
      {/* Only the status: the timestamps beside the badge tick every 20 seconds and would be
          read out each time. */}
      <p role="status" className="sr-only">
        {`Status: ${statusLabel(run.status)}.`}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusBadge status={run.status} />
        {run.model ? <code className="font-mono text-xs">{run.model}</code> : null}
        <span className="text-xs text-muted-foreground">
          Started <RelativeTime iso={run.created_at} />
        </span>
        {finished ? (
          <RunClock
            status={run.status}
            createdAt={run.created_at}
            updatedAt={run.updated_at}
            className="text-xs text-muted-foreground"
          />
        ) : null}
        {usage.map((part) => (
          <span key={part} className="text-xs text-muted-foreground">
            {part}
          </span>
        ))}
        {finished ? null : (
          <span
            className={`ml-auto text-xs ${connection === "offline" ? "text-attention" : "text-muted-foreground"}`}
          >
            {connection === "live"
              ? "Live"
              : connection === "connecting"
                ? "Connecting…"
                : "Live updates lost, reconnecting…"}
          </span>
        )}
      </div>
      {/* The scripted model is kept for tests (no key, no cost) and is the default when no model
          is set, so a run on it looks like any other run. Its output is mechanical, never a
          submission. */}
      {run.model === SCRIPTED_MODEL ? (
        <p className="text-sm text-attention">
          Test model: this run used the scripted model, not a real one. Its requirements are
          placeholders. Do not upload them. Set a model in Settings and run again.
        </p>
      ) : null}

      {finished ? null : (
        // What the run is doing now and for how long: the trace below is complete but long, and
        // a run of several minutes looked stuck with only "1 min ago" (first experiments).
        <section aria-label="Progress" className="grid gap-1.5 rounded-md border bg-card px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-medium">{describeActivity(events)}</span>
            <RunClock
              status={run.status}
              createdAt={run.created_at}
              className="ml-auto text-xs text-muted-foreground tabular-nums"
            />
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full w-full animate-pulse bg-tint/50" />
          </div>
          <span className="text-xs text-muted-foreground">
            {timeline.length} {timeline.length === 1 ? "step" : "steps"} so far. This page updates as the agent
            reports.
          </span>
        </section>
      )}

      <section className="grid gap-1">
        <h2 className="text-xs font-medium text-muted-foreground">Task</h2>
        <p className="max-h-60 overflow-auto rounded-md border bg-card px-3 py-2 break-words whitespace-pre-wrap">
          {run.task}
        </p>
      </section>

      {notice ? (
        <p role="alert" className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-danger">
          {notice}
        </p>
      ) : null}

      {showRetry ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-3 py-2">
          <p className="min-w-0 flex-1 basis-64">
            {run.status === "queued"
              ? agentUnreachable
                ? "The agent could not be reached when this run was created, so it is still queued."
                : "This run is queued: the agent has not picked it up yet."
              : "Every approval has been decided, but the agent has not resumed this run."}
          </p>
          <Button variant="outline" onClick={retry} disabled={retrying}>
            {retrying ? "Calling the agent…" : run.status === "queued" ? "Send to agent" : "Resume run"}
          </Button>
        </div>
      ) : null}

      {stalled && canAct ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-attention-border bg-attention-surface px-3 py-2 text-attention">
          <p className="min-w-0 flex-1 basis-64">
            The agent has not reported for over a minute. It probably stopped mid-run. Closing the
            run marks it failed; nothing is re-run.
          </p>
          <Button variant="outline" onClick={retry} disabled={retrying}>
            {retrying ? "Calling the agent…" : "Close run"}
          </Button>
        </div>
      ) : null}

      {pending.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onDecide={canAct ? decide : null} />
      ))}

      {run.error ? (
        <section className="grid gap-1">
          <h2 className="text-xs font-medium text-danger">Error</h2>
          <p className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-danger">
            {run.error}
          </p>
        </section>
      ) : null}

      {run.output ? <RunResult output={run.output} runId={run.id} /> : null}

      {!run.output && run.case_id && run.status !== "queued" ? (
        <StoredSubmission runId={run.id} organizationId={run.organization_id ?? null} />
      ) : null}

      {run.status === "succeeded" && looksLikeSubmission(run.output) ? <CertivityChecks text={run.output} organizationId={run.organization_id ?? null} /> : null}

      <section className="grid gap-1">
        <h2 className="text-xs font-medium text-muted-foreground">
          Trace
          <span className="ml-1.5 font-normal">
            ({events.length} {events.length === 1 ? "event" : "events"})
          </span>
        </h2>
        {timeline.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-5 text-center text-muted-foreground">
            {finished ? "This run recorded no events." : "Nothing yet. Events appear here as the agent works."}
          </p>
        ) : (
          <Timeline items={timeline} startedAt={run.created_at} runFinished={finished} />
        )}
      </section>

    </div>
  );
}
