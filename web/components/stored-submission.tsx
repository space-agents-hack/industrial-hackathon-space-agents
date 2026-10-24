"use client";

import { useState } from "react";

import { CertivityChecks } from "@/components/certivity-checks";
import { RunResult } from "@/components/run-result";
import { Button } from "@/components/ui/button";

// For a run with a case that has no output: it ran out of time, hit a limit, failed, or waits on
// an approval. Its requirements were stored window by window, so the file can still be built from
// them and uploaded (#36). On request, not on load: it reads every stored row.
export function StoredSubmission({ runId, organizationId }: { runId: string; organizationId: string | null }) {
  const [state, setState] = useState<
    { phase: "idle" } | { phase: "loading" } | { phase: "done"; text: string } | { phase: "failed"; error: string }
  >({ phase: "idle" });

  async function build() {
    setState({ phase: "loading" });
    try {
      const response = await fetch(`/api/runs/${runId}/submission`, { cache: "no-store" });
      const body: { text?: string; error?: string } = await response.json().catch(() => ({}));
      if (response.ok && typeof body.text === "string") setState({ phase: "done", text: body.text });
      else setState({ phase: "failed", error: body.error ?? `The file could not be built (${response.status}).` });
    } catch {
      setState({ phase: "failed", error: "The server did not answer." });
    }
  }

  if (state.phase === "done") {
    return (
      <>
        <RunResult output={state.text} runId={runId} title="Requirements stored so far" />
        <CertivityChecks text={state.text} organizationId={organizationId} />
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-3 py-2">
      <p className="min-w-0 flex-1 basis-64">
        This run has not written a submission. The requirements it stored so far can be built into the same file,
        without the rejected ones.
        {state.phase === "failed" ? <span className="block text-danger">{state.error}</span> : null}
      </p>
      <Button variant="outline" onClick={() => void build()} disabled={state.phase === "loading"}>
        {state.phase === "loading" ? "Building…" : "Build the file"}
      </Button>
    </div>
  );
}
