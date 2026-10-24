"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { RUN_LIST_LIMIT, fetchRunList } from "@/lib/runs";
import { createClient } from "@/lib/supabase/client";
import { type RunSummary, isRunRow, mergeRunList, summarizeRun } from "@/lib/trace";

// Each subscription gets its own topic. Leaving a channel is asynchronous, and asking for the
// same topic while the old one is still leaving hands back the old, already-subscribed channel.
let subscriptions = 0;

export function RunList({
  initialRuns,
  organizationId,
  canStart,
}: {
  initialRuns: RunSummary[];
  organizationId: string;
  canStart: boolean;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | undefined;

    async function refetch() {
      try {
        const fresh = await fetchRunList(supabase, organizationId);
        if (cancelled) return;
        setRuns(fresh);
        setStale(false);
      } catch {
        if (!cancelled) setStale(true);
      }
    }

    async function subscribe() {
      // The socket must carry the user's token before the channel joins; a channel joined
      // without it is subject to RLS as an anonymous user and receives nothing.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`runs:${organizationId}:${++subscriptions}`)
        // Only this organisation: RLS alone would also deliver the runs of every other
        // organisation the person can read.
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "runs", filter: `organization_id=eq.${organizationId}` },
          (change) => {
            // A new run's project and case are not in the change; the refetch reads them.
            if (change.eventType !== "UPDATE" || !isRunRow(change.new)) {
              void refetch();
              return;
            }
            const run = summarizeRun(change.new);
            setRuns((current) =>
              mergeRunList(current, [{ ...run, where: current.find((r) => r.id === run.id)?.where }], RUN_LIST_LIMIT),
            );
          },
        )
        .subscribe((state) => {
          // Runs created between the server render and this moment were never announced.
          if (state === "SUBSCRIBED") void refetch();
        });
    }

    function onVisible() {
      if (document.visibilityState === "visible") void refetch();
    }

    void subscribe();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [organizationId]);

  if (runs.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
        {canStart ? "No runs yet. Start one above." : "No runs yet."}
      </p>
    );
  }

  return (
    <div className="grid gap-1.5">
      {stale ? (
        <p role="status" className="text-xs text-attention">
          The list could not be refreshed. It will try again when this tab regains focus.
        </p>
      ) : null}
      <ul className="divide-y rounded-md border bg-card">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/runs/${run.id}`}
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[9.5rem_1fr_auto_5.5rem]"
            >
              <StatusBadge status={run.status} />
              <span className="order-last col-span-2 min-w-0 truncate sm:order-none sm:col-span-1">
                {run.where ? <span className="text-muted-foreground">{run.where} · </span> : null}
                {run.preview}
              </span>
              <span className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground sm:inline">
                {run.model ?? ""}
              </span>
              <RelativeTime
                iso={run.created_at}
                className="text-right text-xs whitespace-nowrap text-muted-foreground"
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
