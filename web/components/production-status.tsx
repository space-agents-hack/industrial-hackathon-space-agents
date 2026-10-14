"use client";

import { useEffect, useState } from "react";

import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/trace";

type Endpoint = { url: string | null; healthy: boolean; detail: string; model?: string };
type ReleaseRun = { status: string; conclusion: string | null; url: string; createdAt: string; title: string };
type Status = { linked: boolean; web: Endpoint | null; agent: Endpoint | null; release: ReleaseRun | null };

// What is live, from this machine: links to both production addresses, whether they answer, and
// how the latest release went. Reads only; see lib/setup-commands.ts.
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

  const release = status?.release ?? null;
  const running = release !== null && release.status !== "completed";
  const up = Boolean(status?.web?.healthy && status.agent?.healthy);

  return (
    <div className="grid gap-2">
      {checking && !status ? <p className="text-muted-foreground">Asking Vercel and GitHub…</p> : null}
      {!checking && !status ? (
        <p className="text-red-700">
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
                ? "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2"
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
            ) : running ? (
              "A release is running. Check again when it finishes (a few minutes)."
            ) : (
              "Production is not answering yet. The latest release below says why."
            )}
          </p>
          <dl className="grid gap-1.5 text-sm sm:grid-cols-[8rem_1fr]">
            <Row label="Web app" endpoint={status.web} />
            <Row label="Agent" endpoint={status.agent} />
            <dt className="text-muted-foreground">Latest release</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {release ? (
                <>
                  <ToneBadge tone={releaseTone(release)} pulse={running}>
                    {releaseLabel(release)}
                  </ToneBadge>
                  <span className="text-muted-foreground">{new Date(release.createdAt).toLocaleString()}</span>
                  <a href={release.url} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                    View on GitHub
                  </a>
                </>
              ) : (
                <span className="text-muted-foreground">None yet.</span>
              )}
            </dd>
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

function releaseLabel(release: ReleaseRun): string {
  if (release.status !== "completed") return "Running";
  if (release.conclusion === "success") return "Succeeded";
  if (release.conclusion === "failure") return "Failed";
  return release.conclusion ?? "Finished";
}

function releaseTone(release: ReleaseRun): Tone {
  if (release.status !== "completed") return "blue";
  return release.conclusion === "success" ? "green" : release.conclusion === "failure" ? "red" : "neutral";
}
