"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EDITABLE_SECRETS, type SecretName, needsProviderKey } from "@/lib/deployment";
import { sendJson } from "@/lib/send-json";

// New values for the deployment (lib/deployment.ts). Every field starts empty and an empty field
// keeps what GitHub holds: stored values are never sent to the browser, so there is nothing to
// prefill and nothing to leak.
export function DeploymentForm({ currentModel }: { currentModel: string }) {
  const router = useRouter();
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [model, setModel] = useState(currentModel);
  const [renew, setRenew] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const modelChanged = model.trim() !== "" && model.trim() !== currentModel;
  const changed = Object.values(secrets).some(Boolean) || modelChanged || renew;

  async function submit(apply: boolean) {
    setBusy(true);
    setMessage(null);
    const result = await sendJson<{ saved: string[]; started: boolean }>("/api/admin/deployment", "POST", {
      secrets,
      agent_model: modelChanged ? model.trim() : "",
      renew_shared_secret: renew,
      apply,
      password,
    });
    setBusy(false);
    setPassword("");
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setSecrets({});
    setRenew(false);
    const saved = result.body.saved.length ? `Saved ${result.body.saved.join(", ")} in GitHub.` : "Nothing new to save.";
    setMessage({
      ok: true,
      text: result.body.started
        ? `${saved} The Bootstrap workflow is starting; it carries the values to Vercel and Supabase, then releases. Follow it below.`
        : `${saved} Nothing changes in production until you apply.`,
    });
    router.refresh();
  }

  return (
    <form
      className="grid max-w-3xl gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {EDITABLE_SECRETS.map(({ name, label, hint }) => (
          <div key={name} className="grid gap-1">
            <Label htmlFor={`secret-${name}`}>{label}</Label>
            <Input
              id={`secret-${name}`}
              type={name === "SUPABASE_PROJECT_REF" ? "text" : "password"}
              value={secrets[name] ?? ""}
              onChange={(e) => setSecrets((current) => ({ ...current, [name]: e.target.value }))}
              placeholder="unchanged"
              // Not a login form: keep password managers from filling or saving these.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              className="font-mono"
            />
            <span className="text-xs text-muted-foreground">{hint}</span>
          </div>
        ))}
        <div className="grid gap-1">
          <Label htmlFor="agent-model">Default model</Label>
          <Input
            id="agent-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            className="font-mono"
          />
          <span className="text-xs text-muted-foreground">
            for organisations that did not choose one in Models and limits
            {modelChanged && needsProviderKey(model.trim()) ? "; needs its API key above unless already stored" : ""}
          </span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={renew} onChange={(e) => setRenew(e.target.checked)} />
        Renew the secret between web and agent (runs started during the release may fail once)
      </label>

      <div className="grid max-w-sm gap-1">
        <Label htmlFor="confirm-password">Your password, to confirm</Label>
        <Input
          id="confirm-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !password}>
          {busy ? "Working…" : changed ? "Save and apply" : "Apply again"}
        </Button>
        <Button type="button" variant="outline" disabled={busy || !password || !changed} onClick={() => void submit(false)}>
          Save only
        </Button>
        <span className="text-xs text-muted-foreground">
          Apply runs the Bootstrap workflow and then a release: a few minutes.
        </span>
      </div>

      {message ? (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-success" : "text-danger"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
