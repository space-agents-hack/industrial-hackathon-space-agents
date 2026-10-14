"use client";

import { useEffect, useState } from "react";

import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

type Status =
  | { known: false }
  | { known: true; url: string; checks: Record<string, string> | null; detail: string };

const PARTS: [string, string][] = [
  ["web", "Web app"],
  ["agent", "Agent"],
  ["auth", "Sign-in (Supabase Auth)"],
];

// What is live, from this machine: the production address the Bootstrap workflow stored in GitHub
// and its deep health check. Reads only; see lib/setup-commands.ts.
export function ProductionStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [checking, setChecking] = useState(true);

  async function check() {
    setChecking(true);
    try {
      const response = await fetch("/api/setup/production", { cache: "no-store" });
      setStatus(response.ok ? await response.json() : null);
      setFailed(response.ok ? null : response.status);
    } catch {
      setStatus(null);
      setFailed(0);
    }
    setChecking(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
  }, []);

  const up = status?.known && status.checks !== null && PARTS.every(([key]) => status.checks?.[key] === "ok");

  return (
    <div className="grid gap-2">
      {checking && !status ? <p className="text-muted-foreground">Asking GitHub and production…</p> : null}
      {!checking && !status ? (
        <p className="text-danger">
          Could not check production{failed ? ` (the local server answered ${failed})` : ""}.
        </p>
      ) : null}
      {status && !status.known ? (
        <p className="text-muted-foreground">No production address yet: the Bootstrap workflow stores it.</p>
      ) : null}
      {status?.known ? (
        <>
          <p
            className={
              up
                ? "rounded-md border border-success-border bg-success-surface px-3 py-2"
                : "rounded-md border bg-card px-3 py-2"
            }
          >
            {up ? "Production is up. " : `Production is not fully up: ${status.detail} `}
            <a href={status.url} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">
              Open {status.url.replace("https://", "")}
            </a>
          </p>
          {status.checks ? (
            <dl className="grid gap-1.5 text-sm sm:grid-cols-[12rem_1fr]">
              {PARTS.map(([key, label]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <ToneBadge tone={status.checks?.[key] === "ok" ? "green" : "red"}>
                      {status.checks?.[key] === "ok" ? "OK" : "Problem"}
                    </ToneBadge>
                    {status.checks?.[key] && status.checks[key] !== "ok" ? (
                      <span className="text-xs text-muted-foreground">{status.checks[key]}</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : null}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={check} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </Button>
      </div>
    </div>
  );
}
