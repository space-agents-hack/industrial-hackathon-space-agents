"use client";

import { useEffect, useState } from "react";

import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

type Endpoint = { url: string | null; healthy: boolean; detail: string; model?: string };
type Status = { linked: boolean; web: Endpoint | null; agent: Endpoint | null };

// What is live, from this machine: links to both production addresses and whether they answer.
// Reads only; see lib/setup-commands.ts. Releases are shown by ReleaseProgress.
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
    // A one-off check on load; asking Vercel and GitHub takes a few seconds.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
  }, []);

  const up = Boolean(status?.web?.healthy && status.agent?.healthy);

  return (
    <div className="grid gap-2">
      {checking && !status ? <p className="text-muted-foreground">Asking Vercel…</p> : null}
      {!checking && !status ? (
        <p className="text-danger">
          Could not check production
          {failed ? ` (the local server answered ${failed})` : ""}. After pulling new code the
          local server sometimes keeps an old copy: stop <code className="font-mono">make dev</code>{" "}
          (Ctrl-C), start it again and reload.
        </p>
      ) : null}
      {status && !status.linked ? (
        <p className="text-muted-foreground">Not connected yet: the Vercel projects are not linked.</p>
      ) : null}

      {status?.linked ? (
        <>
          <p
            className={
              up
                ? "rounded-md border border-success-border bg-success-surface px-3 py-2"
                : "rounded-md border bg-card px-3 py-2"
            }
          >
            {up ? (
              <>
                Production is up.{" "}
                {status.web?.url ? (
                  <a href={status.web.url} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">
                    Open {status.web.url.replace("https://", "")}
                  </a>
                ) : null}{" "}
                and sign in with a user you created.
              </>
            ) : (
              "Production is not answering yet. The release in the step above says why."
            )}
          </p>
          <dl className="grid gap-1.5 text-sm sm:grid-cols-[8rem_1fr]">
            <Row label="Web app" endpoint={status.web} />
            <Row label="Agent" endpoint={status.agent} />
          </dl>
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

function Row({ label, endpoint }: { label: string; endpoint: Endpoint | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={endpoint?.healthy ? "green" : "red"}>{endpoint?.healthy ? "Answering" : "Down"}</ToneBadge>
        {endpoint?.url ? (
          <a href={endpoint.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary underline underline-offset-2">
            {endpoint.url.replace("https://", "")}
          </a>
        ) : null}
        {endpoint?.model ? <span className="text-xs text-muted-foreground">model {endpoint.model}</span> : null}
        {endpoint && !endpoint.healthy ? <span className="text-xs text-muted-foreground">{endpoint.detail}</span> : null}
      </dd>
    </>
  );
}
