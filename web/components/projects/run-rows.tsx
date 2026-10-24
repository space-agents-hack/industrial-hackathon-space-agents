import Link from "next/link";

import { RelativeTime } from "@/components/relative-time";
import { RunClock } from "@/components/run-clock";
import { StatusBadge } from "@/components/status-badge";
import type { RunSummary } from "@/lib/trace";

// The runs of one case or one project, as read when the page was rendered. Not live: the home
// page's list is, and a run opened from here shows its own progress.
export function RunRows({ runs, empty }: { runs: (RunSummary & { where?: string })[]; empty: string }) {
  if (runs.length === 0) {
    return <p className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y rounded-md border bg-card">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            href={`/runs/${run.id}`}
            className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[9.5rem_1fr_auto_auto]"
          >
            <StatusBadge status={run.status} />
            <span className="order-last col-span-2 min-w-0 truncate sm:order-none sm:col-span-1">
              {run.where ? <span className="text-muted-foreground">{run.where} · </span> : null}
              {run.preview}
            </span>
            <span className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground sm:inline">
              {run.model ?? ""}
            </span>
            <span className="grid text-right text-xs whitespace-nowrap text-muted-foreground">
                <RelativeTime iso={run.created_at} />
                <RunClock status={run.status} createdAt={run.created_at} updatedAt={run.updated_at} />
              </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
