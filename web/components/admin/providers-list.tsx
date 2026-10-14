"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { ToneBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROVIDERS, type ProviderId, sourceLabel } from "@/lib/admin";
import { sendJson } from "@/lib/send-json";
import { cn } from "@/lib/utils";

export type Connection = {
  provider: ProviderId;
  last4: string;
  source: string;
  createdAt: string;
  createdBy: string | null;
};

export function ProvidersList({ org, connections }: { org: string; connections: Connection[] }) {
  return (
    <ul className="divide-y rounded-md border bg-card">
      {PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          org={org}
          provider={provider.id}
          label={provider.label}
          connection={connections.find((c) => c.provider === provider.id) ?? null}
        />
      ))}
    </ul>
  );
}

function ProviderRow({
  org,
  provider,
  label,
  connection,
}: {
  org: string;
  provider: ProviderId;
  label: string;
  connection: Connection | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "paste" | "confirm-delete">("idle");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inputId = `key-${provider}`;

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/providers", "POST", { org, provider, api_key: key });
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    // The key leaves the page's memory as soon as it is stored.
    setKey("");
    setMode("idle");
    setMessage({ ok: true, text: "Key checked with the provider and stored." });
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/providers", "DELETE", { org, provider });
    setBusy(false);
    setMode("idle");
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setMessage({ ok: true, text: "Key removed." });
    router.refresh();
  }

  return (
    <li className="grid gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="w-24 font-medium">{label}</span>
        {connection ? (
          <ToneBadge tone="green">Connected</ToneBadge>
        ) : (
          <ToneBadge tone="neutral">Not connected</ToneBadge>
        )}
        {connection ? (
          <span className="text-xs text-muted-foreground">
            <code className="font-mono">…{connection.last4}</code> · {sourceLabel(connection.source)} ·{" "}
            <RelativeTime iso={connection.createdAt} />
            {connection.createdBy ? ` · ${connection.createdBy}` : ""}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {provider === "openrouter" ? (
            // A plain link: the start route answers with a redirect to openrouter.ai.
            <a
              href={`/api/admin/providers/openrouter/start?${new URLSearchParams({ org })}`}
              className={cn(buttonVariants({ variant: connection ? "outline" : "default", size: "sm" }))}
            >
              {connection ? "Reconnect OpenRouter" : "Connect OpenRouter"}
            </a>
          ) : null}
          {mode === "idle" ? (
            <Button variant="outline" size="sm" onClick={() => setMode("paste")}>
              {connection ? "Replace key" : "Paste a key"}
            </Button>
          ) : null}
          {connection && mode === "idle" ? (
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:text-danger"
              onClick={() => setMode("confirm-delete")}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {mode === "paste" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {label} API key
          </label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${label} API key`}
            className="min-w-0 flex-1 basis-64 font-mono"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || key.trim() === ""}>
            {busy ? "Checking…" : "Check and save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setKey("");
              setMode("idle");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {mode === "confirm-delete" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger-border bg-danger-surface px-2 py-1.5">
          <p className="min-w-0 flex-1 basis-64 text-danger">
            Remove the {label} key? Runs that use a {label} model fail until a key is added again.
          </p>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove key"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role={message.ok ? "status" : "alert"} className={cn("text-xs", message.ok ? "text-success" : "text-danger")}>
          {message.text}
        </p>
      ) : null}
    </li>
  );
}
