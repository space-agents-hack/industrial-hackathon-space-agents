"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { ToneBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_SCHEMES,
  type AuthScheme,
  PROVIDERS,
  type ProviderId,
  authSchemeLabel,
  isEndpointProvider,
  sourceLabel,
} from "@/lib/admin";
import { sendJson } from "@/lib/send-json";
import { cn } from "@/lib/utils";

export type Connection = {
  provider: ProviderId;
  last4: string;
  source: string;
  createdAt: string;
  createdBy: string | null;
  // Set for a self-hosted server (Ollama) only. Never the token or password itself.
  baseUrl: string | null;
  authScheme: AuthScheme | null;
  username: string | null;
};

export function ProvidersList({ org, connections }: { org: string; connections: Connection[] }) {
  return (
    <ul className="divide-y rounded-md border bg-card">
      {PROVIDERS.map((provider) =>
        isEndpointProvider(provider.id) ? (
          <EndpointRow
            key={provider.id}
            org={org}
            provider={provider.id}
            label={provider.label}
            connection={connections.find((c) => c.provider === provider.id) ?? null}
          />
        ) : (
          <ProviderRow
            key={provider.id}
            org={org}
            provider={provider.id}
            label={provider.label}
            connection={connections.find((c) => c.provider === provider.id) ?? null}
          />
        ),
      )}
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

// A server the organisation runs itself. The agent calls it, not the browser: "localhost" here
// means the machine the agent runs on, which for a hosted deployment is not the person's laptop.
function EndpointRow({
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
  const [mode, setMode] = useState<"idle" | "edit" | "confirm-delete">("idle");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "http://localhost:11434");
  const [authScheme, setAuthScheme] = useState<AuthScheme>(connection?.authScheme ?? "none");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const id = (field: string) => `${provider}-${field}`;
  // Same scheme as stored: an empty secret field keeps the stored token or password.
  const keepsSecret = connection !== null && connection.authScheme === authScheme && authScheme !== "none";
  const needsSecret = authScheme !== "none" && !keepsSecret;

  function edit() {
    setBaseUrl(connection?.baseUrl ?? "http://localhost:11434");
    setAuthScheme(connection?.authScheme ?? "none");
    setUsername(connection?.username ?? "");
    setSecret("");
    setMessage(null);
    setMode("edit");
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/providers/endpoint", "POST", {
      org,
      provider,
      base_url: baseUrl,
      auth_scheme: authScheme,
      username: authScheme === "basic" ? username : null,
      secret: authScheme === "none" || secret === "" ? null : secret,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setSecret("");
    setMode("idle");
    setMessage({ ok: true, text: "The server answered and its settings are stored." });
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
    setMessage({ ok: true, text: "Server disconnected." });
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
            <code className="font-mono">{connection.baseUrl}</code> · {authSchemeLabel(connection.authScheme).toLowerCase()}
            {connection.authScheme === "basic" && connection.username ? ` as ${connection.username}` : ""}
            {connection.authScheme === "bearer" && connection.last4 ? (
              <>
                {" "}
                <code className="font-mono">…{connection.last4}</code>
              </>
            ) : null}{" "}
            · <RelativeTime iso={connection.createdAt} />
            {connection.createdBy ? ` · ${connection.createdBy}` : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">A model server you run yourself, instead of a hosted provider.</span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {mode === "idle" ? (
            <Button variant="outline" size="sm" onClick={edit}>
              {connection ? "Change" : "Connect a server"}
            </Button>
          ) : null}
          {connection && mode === "idle" ? (
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:text-danger"
              onClick={() => setMode("confirm-delete")}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>

      {mode === "edit" ? (
        <form
          className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label htmlFor={id("url")}>Server URL</Label>
          <Input
            id={id("url")}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:11434"
            className="min-w-0 font-mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <Label htmlFor={id("auth")}>Authentication</Label>
          <select
            id={id("auth")}
            className="h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm"
            value={authScheme}
            onChange={(event) => setAuthScheme(event.target.value as AuthScheme)}
          >
            {AUTH_SCHEMES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          {authScheme === "basic" ? (
            <>
              <Label htmlFor={id("user")}>User name</Label>
              <Input
                id={id("user")}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </>
          ) : null}
          {authScheme !== "none" ? (
            <>
              <Label htmlFor={id("secret")}>{authScheme === "basic" ? "Password" : "Token"}</Label>
              <Input
                id={id("secret")}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={keepsSecret ? "Leave empty to keep the stored one" : ""}
                className="min-w-0 font-mono"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </>
          ) : null}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The agent calls this address, not your browser. <code className="font-mono">localhost</code> works when the
            agent runs on the same machine as Ollama; a hosted agent needs an address it can reach, such as a tunnel
            with a token in front of Ollama.
          </p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                busy ||
                baseUrl.trim() === "" ||
                (needsSecret && secret === "") ||
                (authScheme === "basic" && username.trim() === "")
              }
            >
              {busy ? "Checking…" : "Check and save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setSecret("");
                setMode("idle");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "confirm-delete" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger-border bg-danger-surface px-2 py-1.5">
          <p className="min-w-0 flex-1 basis-64 text-danger">
            Disconnect the {label} server? Runs that use a {label} model fail until it is connected again.
          </p>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Disconnecting…" : "Disconnect"}
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
