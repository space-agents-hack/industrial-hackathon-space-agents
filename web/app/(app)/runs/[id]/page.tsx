import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { RunTrace } from "@/components/run-trace";
import { fetchApprovals, fetchRun, fetchRunEvents } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Run" };

export default function RunPage({ params, searchParams }: PageProps<"/runs/[id]">) {
  return (
    <div className="grid gap-3">
      <Link href="/" className="w-fit text-xs text-muted-foreground hover:text-foreground">
        ← All runs
      </Link>
      {/* The run id and the session are only known at request time, so everything that depends
          on them streams in behind this boundary. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading run…</p>}>
        <Run params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Run({ params, searchParams }: PageProps<"/runs/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) return <Missing />;

  const supabase = await createClient();
  const [run, events, approvals] = await Promise.all([
    fetchRun(supabase, id),
    fetchRunEvents(supabase, id),
    fetchApprovals(supabase, id),
  ]);
  if (!run) return <Missing />;

  return (
    <RunTrace
      key={run.id}
      initialRun={run}
      initialEvents={events}
      initialApprovals={approvals}
      agentUnreachable={query.agent === "unreachable"}
    />
  );
}

function Missing() {
  return <p className="text-muted-foreground">This run does not exist.</p>;
}
