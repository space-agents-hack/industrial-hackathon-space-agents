"use client";

import { useSyncExternalStore } from "react";

import { formatRelativeWithClock, formatUtc } from "@/lib/trace";

// One shared clock for every timestamp on the page. On the server and during hydration there is
// no clock (the snapshot is null) and the absolute UTC time is rendered, so the HTML is the same
// on both sides; the relative text takes over once the browser has mounted.
const listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const notify of listeners) notify();
  }, 20_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => now;
const getServerSnapshot = () => 0;

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const nowMs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const absolute = formatUtc(iso);
  return (
    <time dateTime={iso} title={absolute} className={className}>
      {nowMs === 0 ? absolute : formatRelativeWithClock(iso, nowMs)}
    </time>
  );
}
