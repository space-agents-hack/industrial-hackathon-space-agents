"use client";

import { useSyncExternalStore } from "react";

import { formatDuration, isFinished } from "@/lib/trace";

// One clock ticking each second for every unfinished run on the page. On the server and during
// hydration there is none (the snapshot is 0) and nothing is rendered, so the HTML matches.
const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const notify of listeners) notify();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// "running 3 min 20 s" while a run is unfinished; "took 4 min 02 s" once it is.
export function RunClock({
  status,
  createdAt,
  updatedAt,
  className,
}: {
  status: string;
  createdAt: string;
  updatedAt?: string;
  className?: string;
}) {
  const nowMs = useSyncExternalStore(
    subscribe,
    () => now,
    () => 0,
  );
  if (nowMs === 0) return null;
  const start = Date.parse(createdAt);
  if (isFinished(status)) {
    if (!updatedAt) return null;
    return <span className={className}>took {formatDuration(Date.parse(updatedAt) - start)}</span>;
  }
  return (
    <span className={className}>
      {status === "queued" ? "queued" : "running"} {formatDuration(nowMs - start)}
    </span>
  );
}
