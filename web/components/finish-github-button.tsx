"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

// When GitHub comes back without the value that proves it is this browser's own install, nothing
// is written until the person confirms here (app/api/setup/github/installed, POST).
export function FinishGithubButton({ installationId }: { installationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/setup/github/installed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installation_id: installationId }),
      });
      const body = (await response.json().catch(() => ({}))) as { release?: string; error?: string };
      if (!response.ok) {
        setError(body.error ?? `The local server answered ${response.status}.`);
        setBusy(false);
        return;
      }
      router.replace(`/setup?env=production&github=installed&release=${encodeURIComponent(body.release ?? "later")}`);
    } catch {
      setError("The local server did not answer. Is make dev still running?");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" onClick={finish} disabled={busy}>
        {busy ? "Finishing…" : "Finish connecting GitHub"}
      </Button>
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
