"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

// Starts the Deploy workflow on main from the local Setup page (lib/setup-commands.ts).
export function ReleaseButton() {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "starting" } | { kind: "started"; url: string | null } | { kind: "failed"; detail: string }
  >({ kind: "idle" });

  async function start() {
    setState({ kind: "starting" });
    try {
      const response = await fetch("/api/setup/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body: { url?: string | null; detail?: string } = await response.json().catch(() => ({}));
      setState(
        response.ok
          ? { kind: "started", url: body.url ?? null }
          : { kind: "failed", detail: body.detail ?? `The request failed (${response.status}).` },
      );
    } catch {
      setState({ kind: "failed", detail: "The local server did not answer." });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={start} disabled={state.kind === "starting"}>
        {state.kind === "starting" ? "Starting…" : "Start the release"}
      </Button>
      {state.kind === "started" ? (
        <span>
          Started.{" "}
          {state.url ? (
            <a href={state.url} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              Follow it on GitHub
            </a>
          ) : (
            "Follow it in the repository's Actions tab."
          )}
        </span>
      ) : null}
      {state.kind === "failed" ? (
        <span role="alert" className="text-danger">
          {state.detail}
        </span>
      ) : null}
    </div>
  );
}
