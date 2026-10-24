"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

// Checks drafts from the part's table, one after the other (#51): each check reads the
// organisation's library and the answer keys, and twenty at once would queue on the agent anyway.
// The unchecked ones first; after a reloaded answer key or a new judge rate, all of them, so the
// rows are measured against the same thing again.
export function CheckAgain({
  unchecked,
  stale,
  all,
}: {
  unchecked: readonly string[];
  stale: readonly string[];
  all: readonly string[];
}) {
  const router = useRouter();
  const [state, setState] = useState<{ done: number; of: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const ids = unchecked.length > 0 || stale.length > 0 ? [...unchecked, ...stale] : all;
  if (ids.length === 0) return null;
  const label =
    unchecked.length > 0
      ? `Check ${unchecked.length} unchecked ${unchecked.length === 1 ? "draft" : "drafts"}${stale.length > 0 ? ` and ${stale.length} older` : ""}`
      : stale.length > 0
        ? `Check ${stale.length} older ${stale.length === 1 ? "check" : "checks"} again`
        : "Check all again";

  async function run() {
    setFailed(null);
    let errors = 0;
    for (const [i, id] of ids.entries()) {
      setState({ done: i, of: ids.length });
      try {
        const response = await fetch(`/api/runs/${id}/checks`, { method: "POST" });
        if (!response.ok) errors += 1;
      } catch {
        errors += 1;
      }
    }
    setState(null);
    if (errors > 0) setFailed(`${errors} of ${ids.length} could not be checked. Open them to see why.`);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {failed ? <span className="text-danger">{failed}</span> : null}
      <Button variant="outline" size="sm" onClick={() => void run()} disabled={state !== null}>
        {state ? `Checking ${state.done + 1} of ${state.of}…` : label}
      </Button>
    </div>
  );
}
