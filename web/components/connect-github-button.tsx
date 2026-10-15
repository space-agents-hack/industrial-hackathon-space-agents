"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

// Starts GitHub's manifest flow (app/api/setup/github/start): the browser posts the app's
// description to GitHub, the person presses Create there, then Install, and lands back here.
export function ConnectGithubButton({ label = "Connect GitHub" }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/setup/github/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => ({}))) as { action?: string; manifest?: string; error?: string };
      if (!response.ok || !body.action || !body.manifest) {
        setError(body.error ?? `The local server answered ${response.status}.`);
        setBusy(false);
        return;
      }
      // A real form post: GitHub's manifest flow takes the manifest as a form field, not as JSON.
      const form = document.createElement("form");
      form.method = "post";
      form.action = body.action;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = body.manifest;
      form.append(field);
      document.body.append(form);
      form.submit();
    } catch {
      setError("The local server did not answer. Is make dev still running?");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" onClick={connect} disabled={busy}>
        {busy ? "Opening GitHub…" : label}
      </Button>
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
