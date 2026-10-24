"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_MODEL_REQUESTS_LIMIT,
  type ModelOption,
  type ModelSource,
  PROVIDERS,
  type ProviderId,
  SCRIPTED_MODEL,
  formatModelPrice,
  isEndpointProvider,
  listNeedsKey,
  modelName,
  modelSourceOf,
  providerLabel,
} from "@/lib/admin";
import { sendJson } from "@/lib/send-json";

type Stored = { model: string | null; maxModelRequests: number | null; monthlyCostCapUsd: number | null };

// "" is "use the deployment default"; "keep" holds a stored model this build does not recognise,
// so opening the page and saving the limits does not silently drop it.
type SourceChoice = ModelSource | "" | "keep";

type ModelList =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; models: ModelOption[] }
  | { state: "failed"; error: string; needsKey: boolean };

export function SettingsForm({
  org,
  stored,
  defaultModel,
  connected,
}: {
  org: string;
  stored: Stored;
  defaultModel: string | null;
  connected: ProviderId[];
}) {
  const router = useRouter();
  const storedSource = modelSourceOf(stored.model);
  const [source, setSource] = useState<SourceChoice>(
    stored.model === null ? "" : (storedSource ?? "keep"),
  );
  const [model, setModel] = useState(stored.model ?? "");
  const [requests, setRequests] = useState(stored.maxModelRequests?.toString() ?? "");
  const [cap, setCap] = useState(stored.monthlyCostCapUsd?.toString() ?? "");
  const [list, setList] = useState<ModelList>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const provider: ProviderId | null =
    source !== "" && source !== "keep" && source !== SCRIPTED_MODEL ? source : null;
  const missingKey = provider !== null && !connected.includes(provider);

  useEffect(() => {
    if (provider === null || (missingKey && listNeedsKey(provider))) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the list belongs to the provider just chosen
    setList({ state: "loading" });
    fetch(`/api/admin/models?${new URLSearchParams({ org, provider })}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { models?: ModelOption[]; error?: string };
        if (cancelled) return;
        if (response.ok && body.models) setList({ state: "ready", models: body.models });
        else
          setList({
            state: "failed",
            error: body.error ?? `The list could not be loaded (${response.status}).`,
            needsKey: response.status === 409,
          });
      })
      .catch(() => {
        if (!cancelled) setList({ state: "failed", error: "The server did not answer.", needsKey: false });
      });
    return () => {
      cancelled = true;
    };
  }, [org, provider, missingKey]);

  function chooseSource(next: SourceChoice) {
    setSource(next);
    setMessage(null);
    if (next === "") setModel("");
    else if (next === SCRIPTED_MODEL) setModel(SCRIPTED_MODEL);
    else if (next === "keep") setModel(stored.model ?? "");
    // A provider: keep the stored model if it belongs to it, else wait for a choice.
    else setModel(storedSource === next && stored.model ? stored.model : "");
  }

  const models = list.state === "ready" ? list.models : [];
  // The stored model stays selectable even if the provider no longer lists it, so saving the
  // limits does not force a model change.
  const storedMissing = provider !== null && stored.model !== null && storedSource === provider &&
    list.state === "ready" && !models.some((m) => m.id === stored.model);
  const needsModelChoice = provider !== null && model === "";

  async function save() {
    setSaving(true);
    setMessage(null);
    const result = await sendJson("/api/admin/settings", "POST", {
      org,
      model: model === "" ? null : model,
      max_model_requests: requests,
      monthly_cost_cap_usd: cap,
    });
    setSaving(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setMessage({ ok: true, text: "Saved. New runs use these settings." });
    router.refresh();
  }

  return (
    <form
      className="grid max-w-2xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="grid gap-2 rounded-md border bg-card p-3">
        <legend className="px-1 text-sm font-semibold">Model</legend>
        <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center">
          <Label htmlFor="source">Provider</Label>
          <select
            id="source"
            className="h-8 rounded-md border border-input bg-card px-2 text-sm"
            value={source}
            onChange={(event) => chooseSource(event.target.value as SourceChoice)}
          >
            <option value="">Deployment default</option>
            <option value={SCRIPTED_MODEL}>Scripted (no provider, no cost)</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {stored.model !== null && storedSource === null ? (
              <option value="keep">Keep {stored.model}</option>
            ) : null}
          </select>
        </div>

        {source === "" ? (
          <p className="text-xs text-muted-foreground">
            Runs use the deployment&apos;s model:{" "}
            {defaultModel ? (
              <code className="font-mono">{defaultModel}</code>
            ) : (
              "unknown right now (the agent did not answer)"
            )}
            .
          </p>
        ) : null}
        {source === SCRIPTED_MODEL ? (
          <p className="text-xs text-muted-foreground">
            Plays the example task with no provider and no network. Always available.
          </p>
        ) : null}
        {source === "keep" ? (
          <p className="text-xs text-attention">
            The stored model is not one this page recognises. It is kept as it is unless you choose another.
          </p>
        ) : null}

        {provider !== null ? (
          missingKey && listNeedsKey(provider) ? (
            <p className="text-xs text-attention">
              No {providerLabel(provider)} {isEndpointProvider(provider) ? "server" : "key"} is connected, so its
              models cannot be listed.{" "}
              <Link href="/admin/providers" className="underline underline-offset-4">
                {isEndpointProvider(provider) ? "Connect the server first" : "Connect a key first"}
              </Link>
              .
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center">
              <Label htmlFor="model">Model</Label>
              {list.state === "loading" || list.state === "idle" ? (
                <p className="text-xs text-muted-foreground">Loading the list of models…</p>
              ) : list.state === "failed" ? (
                <p role="alert" className="text-xs text-danger">
                  {list.error}
                  {list.needsKey ? (
                    <>
                      {" "}
                      <Link href="/admin/providers" className="underline underline-offset-4">
                        Providers
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : (
                <select
                  id="model"
                  className="h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setMessage(null);
                  }}
                >
                  <option value="" disabled>
                    Choose a model ({models.length})
                  </option>
                  {storedMissing && stored.model ? (
                    <option value={stored.model}>{modelName(stored.model)} (current, no longer listed)</option>
                  ) : null}
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} · {formatModelPrice(option)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )
        ) : null}
        {provider === "openrouter" && missingKey ? (
          <p className="text-xs text-attention">
            The list is public, but runs with an OpenRouter model need a key.{" "}
            <Link href="/admin/providers" className="underline underline-offset-4">
              Connect OpenRouter
            </Link>{" "}
            before saving one.
          </p>
        ) : null}
        {model !== "" && provider !== null ? (
          <p className="font-mono text-xs text-muted-foreground">{model}</p>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border bg-card p-3">
        <legend className="px-1 text-sm font-semibold">Limits</legend>
        <div className="grid gap-1 sm:grid-cols-[10rem_8rem_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="requests">Model requests per run</Label>
          <Input
            id="requests"
            inputMode="numeric"
            placeholder="default"
            value={requests}
            onChange={(event) => setRequests(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            1 to {MAX_MODEL_REQUESTS_LIMIT}. A run that keeps calling the model stops here. Empty: the
            deployment default (the agent&apos;s MAX_MODEL_REQUESTS, 30 unless it was changed).
          </p>
        </div>
        <div className="grid gap-1 sm:grid-cols-[10rem_8rem_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="cap">Monthly cost cap (USD)</Label>
          <Input
            id="cap"
            inputMode="decimal"
            placeholder="default"
            value={cap}
            onChange={(event) => setCap(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            New runs are refused once this month&apos;s recorded cost (UTC) reaches it. Empty: the
            deployment default (the agent&apos;s MONTHLY_COST_CAP_USD; no cap unless it is set). 0 refuses
            every run.
          </p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || needsModelChoice}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {needsModelChoice ? <span className="text-xs text-muted-foreground">Choose a model first.</span> : null}
        {message ? (
          <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-success" : "text-danger"}>
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
