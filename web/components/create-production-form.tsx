"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH } from "@/lib/admin";
import { needsProviderKey } from "@/lib/deployment";
import { REGIONS } from "@/lib/production-answers";

type Choices = {
  orgs: { slug: string; name: string }[];
  projects: { ref: string; name: string; org: string }[];
};

type Phase = "idle" | "running" | "done" | "failed";

// "Create production" (lib/production-answers.ts → scripts/bootstrap.sh). Two tokens and your
// account; the script does the rest. Nothing typed here is saved on this machine.
export function CreateProductionForm({
  defaultEmail,
  knownProjectRef,
  connected,
  tokenUrls,
}: {
  defaultEmail: string;
  // The Supabase project setup used last time, offered first so repeating setup keeps it.
  knownProjectRef: string | null;
  connected: boolean;
  tokenUrls: { vercel: string; supabase: string };
}) {
  const router = useRouter();
  const [vercelToken, setVercelToken] = useState("");
  const [supabaseToken, setSupabaseToken] = useState("");
  const [choices, setChoices] = useState<Choices | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  // "new:<org slug>" or "existing:<project ref>".
  const [target, setTarget] = useState(knownProjectRef ? `existing:${knownProjectRef}` : "");
  const [replaceDatabase, setReplaceDatabase] = useState(false);
  const [region, setRegion] = useState("eu-central-1");
  const [dbPassword, setDbPassword] = useState("");
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [vercelTeam, setVercelTeam] = useState("");
  // Empty keeps the model production has (scripts/bootstrap.sh).
  const [model, setModel] = useState("");
  const [providerKey, setProviderKey] = useState("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // Ask Supabase which organisations and projects the token reaches, once it looks complete.
  useEffect(() => {
    const token = supabaseToken.trim();
    if (!/^sbp_[\w-]{20,}$/.test(token)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/setup/supabase", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await response.json()) as ({ ok: true } & Choices) | { ok: false; error: string };
        if (cancelled) return;
        if (!body.ok) {
          setChoices(null);
          setChoicesError(body.error);
          return;
        }
        setChoices({ orgs: body.orgs, projects: body.projects });
        setChoicesError(null);
        // A connected repository is never steered towards a new project by default.
        setTarget((current) => current || (!connected && body.orgs.length === 1 ? `new:${body.orgs[0].slug}` : ""));
      } catch {
        if (!cancelled) setChoicesError("The local server did not answer.");
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [supabaseToken, connected]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const existing = target.startsWith("existing:");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLog("");
    setPhase("running");
    let response: Response;
    try {
      response = await fetch("/api/setup/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vercel_token: vercelToken,
          supabase_token: supabaseToken,
          ...(existing
            ? { project_ref: target.slice("existing:".length), db_password: dbPassword }
            : { supabase_org: target.slice("new:".length), region, replace_database: replaceDatabase }),
          email,
          password,
          name,
          vercel_team: vercelTeam,
          agent_model: model,
          provider_key: providerKey,
        }),
      });
    } catch {
      setPhase("failed");
      setError("The local server did not answer. Is make dev still running?");
      return;
    }
    if (!response.ok || !response.body) {
      const body: { error?: string } = await response.json().catch(() => ({}));
      setPhase("failed");
      setError(body.error ?? `The request failed (${response.status}).`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let all = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      all += decoder.decode(value, { stream: true });
      setLog(all);
    }
    // Nothing secret stays in the page once it has been used.
    setVercelToken("");
    setSupabaseToken("");
    setDbPassword("");
    setPassword("");
    setProviderKey("");
    const exit = /\nexit (\d+)\s*$/.exec(all);
    if (exit?.[1] === "0") {
      setPhase("done");
      // The page refreshes when the person moves on, so the log (and any warning in it) stays.
    } else {
      setPhase("failed");
      setError("It stopped; the log says why. Fix it and press the button again: repeating is safe.");
      // What the run already stored (a new project, its password) changes what the page offers.
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3" autoComplete="off">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vercel token" hint={<Ext href={tokenUrls.vercel}>create one</Ext>}>
          {(control) => <Secret {...control} value={vercelToken} onChange={setVercelToken} />}
        </Field>
        <Field label="Supabase access token" hint={<Ext href={tokenUrls.supabase}>create one</Ext>}>
          {(control) => <Secret {...control} value={supabaseToken} onChange={setSupabaseToken} />}
        </Field>
        <Field label="Supabase project" hint={choicesError ?? (choices ? null : "appears once the Supabase token is in")}>
          {(control) => (
            <select
              {...control}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              required
              disabled={!choices}
              className="h-8 rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="">Choose…</option>
              {choices ? (
                <>
                  <optgroup label="Create a new project in">
                    {choices.orgs.map((org) => (
                      <option key={org.slug} value={`new:${org.slug}`}>
                        {org.name}
                      </option>
                    ))}
                  </optgroup>
                  {choices.projects.length ? (
                    <optgroup label="Use an existing project">
                      {choices.projects.map((project) => (
                        <option key={project.ref} value={`existing:${project.ref}`}>
                          {project.name} ({project.ref})
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </>
              ) : null}
            </select>
          )}
        </Field>
        {existing ? (
          <Field
            label="Its database password"
            hint={
              target === `existing:${knownProjectRef}`
                ? "empty: keep the one GitHub has"
                : "empty: a new one is set and stored in GitHub (anything else using the old one stops working)"
            }
          >
            {(control) => <Secret {...control} value={dbPassword} onChange={setDbPassword} optional />}
          </Field>
        ) : (
          <Field label="Region" hint="Frankfurt sits next to the Vercel functions">
            {(control) => (
              <select
                {...control}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="h-8 rounded-md border bg-transparent px-2 text-sm"
              >
                {REGIONS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label} ({code})
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Your email" hint="the first admin of the deployed app">
          {(control) => (
            <Input {...control} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field
          label="Your password"
          hint={`${MIN_PASSWORD_LENGTH}+ characters, for signing in to production. If the account exists, this becomes its password.`}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          )}
        </Field>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label="Project name" hint="empty: the repository name">
            {(control) => <Input {...control} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />}
          </Field>
          <Field label="Vercel team slug" hint="only if the token reaches several teams">
            {(control) => (
              <Input {...control} value={vercelTeam} onChange={(e) => setVercelTeam(e.target.value)} spellCheck={false} />
            )}
          </Field>
          <Field label="Default model" hint="empty: keep the current one (scripted the first time); organisations choose their own later">
            {(control) => (
              <Input
                {...control}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="keep"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          {needsProviderKey(model.trim()) ? (
            <Field label="Its API key" hint={model.split(":")[0]}>
              {(control) => <Secret {...control} value={providerKey} onChange={setProviderKey} />}
            </Field>
          ) : null}
        </div>
      </details>

      {connected && target.startsWith("new:") ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={replaceDatabase} onChange={(e) => setReplaceDatabase(e.target.checked)} />
          <span>
            Replace the database: production moves to a new, empty Supabase project. The old one stays
            in Supabase, untouched, until you delete it there.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={phase === "running" || !target || (connected && !existing && !replaceDatabase)}>
          {phase === "running" ? "Working… (a few minutes)" : existing ? "Connect and release" : "Create production"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {existing
            ? "Uses the project and its data as they are; repeating is safe."
            : "Creates a Supabase project (a Free organisation allows two; paid ones bill per project) and two Vercel projects."}
        </span>
      </div>

      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      {phase === "done" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-success">Done. The release has started. Read the log for anything to do by hand.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
            Follow the release
          </Button>
        </div>
      ) : null}
      {log ? (
        <pre
          ref={logRef}
          className="max-h-80 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap"
        >
          {log}
        </pre>
      ) : null}
    </form>
  );
}

type Control = { id: string; "aria-describedby"?: string };

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: (control: Control) => React.ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="grid content-start gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": hint ? hintId : undefined })}
      {hint ? (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Secret({
  value,
  onChange,
  optional = false,
  ...control
}: Control & { value: string; onChange: (value: string) => void; optional?: boolean }) {
  return (
    <Input
      {...control}
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      // Not a login form: keep password managers from filling or saving these.
      autoComplete="new-password"
      data-1p-ignore
      data-lpignore="true"
      spellCheck={false}
      className="font-mono"
      required={!optional}
    />
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  );
}
