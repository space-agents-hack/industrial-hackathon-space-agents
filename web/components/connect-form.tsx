"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, needsProviderKey } from "@/lib/connect-answers";

type CliStatus = { gh: boolean; vercel: boolean; supabase: boolean; repo: string | null };
type Person = { email: string; password: string };
type Phase = "idle" | "running" | "done" | "failed";

const LOGIN: Record<"gh" | "vercel" | "supabase", { label: string; command: string }> = {
  gh: { label: "GitHub", command: "gh auth login" },
  vercel: { label: "Vercel", command: "vercel login" },
  supabase: { label: "Supabase", command: "supabase login" },
};

// Everything scripts/bootstrap.sh asks, as one form. The values go to the local dev server and
// from there to the script's stdin; they are not stored, and are cleared here once it succeeds.
export function ConnectForm() {
  const router = useRouter();
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const [projectRef, setProjectRef] = useState("");
  const [dbPassword, setDbPassword] = useState("");
  const [supabaseToken, setSupabaseToken] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [model, setModel] = useState("scripted");
  const [providerKey, setProviderKey] = useState("");
  const [people, setPeople] = useState<Person[]>([{ email: "", password: "" }]);
  const [applyMigrations, setApplyMigrations] = useState(true);
  const [remember, setRemember] = useState(true);
  const [renewSecret, setRenewSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");
  const [agentDomain, setAgentDomain] = useState("");
  const [secretKey, setSecretKey] = useState("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  async function checkCli() {
    setChecking(true);
    try {
      const response = await fetch("/api/setup/cli", { cache: "no-store" });
      setCli(response.ok ? await response.json() : null);
    } catch {
      setCli(null);
    }
    setChecking(false);
  }

  async function loadSaved() {
    try {
      const response = await fetch("/api/setup/saved", { cache: "no-store" });
      if (!response.ok) return;
      const body: {
        saved: boolean;
        project_ref: string;
        db_password: string;
        supabase_token: string;
        vercel_token: string;
        agent_model: string;
        provider_key: string;
        users: Person[];
      } = await response.json();
      setSaved(body.saved);
      if (!body.saved) return;
      setProjectRef(body.project_ref);
      setDbPassword(body.db_password);
      setSupabaseToken(body.supabase_token);
      setVercelToken(body.vercel_token);
      setModel(body.agent_model || "scripted");
      setProviderKey(body.provider_key);
      if (body.users.length > 0) setPeople(body.users);
    } catch {
      // Nothing saved, or the server is not the local dev server: start with an empty form.
    }
  }

  async function forget() {
    await fetch("/api/setup/saved", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }).catch(() => undefined);
    setSaved(false);
    setDbPassword("");
    setSupabaseToken("");
    setVercelToken("");
    setProviderKey("");
    setPeople((current) => current.map((person) => ({ ...person, password: "" })));
  }

  useEffect(() => {
    // One-off on load, not a subscription: three CLIs to check and a file to read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkCli();
    void loadSaved();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const signedIn = cli !== null && cli.gh && cli.vercel && cli.supabase && cli.repo !== null;

  async function connect(event: React.FormEvent) {
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
          project_ref: projectRef.trim().toLowerCase(),
          db_password: dbPassword,
          supabase_token: supabaseToken,
          vercel_token: vercelToken,
          agent_model: model,
          provider_key: providerKey,
          apply_migrations: applyMigrations,
          users: people,
          name,
          agent_domain: agentDomain,
          secret_key: secretKey,
          remember,
          renew_shared_secret: renewSecret,
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
    const exit = /\nexit (\d+)\s*$/.exec(all);
    if (exit?.[1] === "0") {
      setPhase("done");
      if (remember) {
        setSaved(true);
      } else {
        // Not remembered: nothing secret stays in the page once it is no longer needed.
        setDbPassword("");
        setSupabaseToken("");
        setVercelToken("");
        setProviderKey("");
        setPeople((current) => current.map((person) => ({ ...person, password: "" })));
      }
      router.refresh();
    } else {
      setPhase("failed");
      setError("It stopped. The log says why. Fix it and press Connect again; repeating is safe.");
    }
  }

  return (
    <div className="grid gap-3">
      <CliLine cli={cli} checking={checking} onCheck={checkCli} />

      <form onSubmit={connect} className="grid gap-3" autoComplete="off">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Supabase Project ID"
            hint="in Supabase, not Vercel: the code after /project/ in the dashboard URL"
          >
            {(control) => (
              <Input
                {...control}
                value={projectRef}
                onChange={(e) => setProjectRef(e.target.value)}
                placeholder="20 lowercase letters"
                spellCheck={false}
                required
              />
            )}
          </Field>
          <Field label="Database password" hint="the one you generated">
            {(control) => <Secret {...control} value={dbPassword} onChange={setDbPassword} />}
          </Field>
          <Field
            label="Supabase access token"
            hint={<Ext href="https://supabase.com/dashboard/account/tokens">create one</Ext>}
          >
            {(control) => <Secret {...control} value={supabaseToken} onChange={setSupabaseToken} />}
          </Field>
          <Field label="Vercel token" hint={<Ext href="https://vercel.com/account/tokens">create one</Ext>}>
            {(control) => <Secret {...control} value={vercelToken} onChange={setVercelToken} />}
          </Field>
          <Field label="Model" hint="scripted needs no key">
            {(control) => (
              <Input {...control} value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} required />
            )}
          </Field>
          {needsProviderKey(model) ? (
            <Field label="Provider API key" hint={model.split(":")[0]}>
              {(control) => <Secret {...control} value={providerKey} onChange={setProviderKey} />}
            </Field>
          ) : null}
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">People who can sign in</legend>
          {people.map((person, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                type="email"
                value={person.email}
                onChange={(e) => update(setPeople, index, { email: e.target.value })}
                placeholder="email"
                aria-label={`Email of person ${index + 1}`}
              />
              <PersonPassword
                value={person.password}
                onChange={(password) => update(setPeople, index, { password })}
                label={`Password of person ${index + 1}`}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setPeople((current) => current.filter((_, i) => i !== index))}
                disabled={people.length === 1}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPeople((current) => [...current, { email: "", password: "" }])}
            >
              Add person
            </Button>
          </div>
        </fieldset>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={applyMigrations}
            onChange={(e) => setApplyMigrations(e.target.checked)}
          />
          Create the database tables now (applies the migrations; cannot be undone)
        </label>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember these on this machine
          </label>
          <span className="text-xs text-muted-foreground">
            Saved on this machine only, in <code className="font-mono">.env.setup.local</code>:
            readable by your user account alone, never committed, never deployed.
          </span>
          {saved ? (
            <Button type="button" variant="outline" size="sm" onClick={forget}>
              Forget saved values
            </Button>
          ) : null}
        </div>

        {saved ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={renewSecret} onChange={(e) => setRenewSecret(e.target.checked)} />
            Renew the secret between the web and the agent (then start a release)
          </label>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Vercel project name" hint="empty: the repository name">
              {(control) => (
                <Input {...control} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
              )}
            </Field>
            <Field label="Agent domain" hint="empty: the one Vercel assigns">
              {(control) => (
                <Input
                  {...control}
                  value={agentDomain}
                  onChange={(e) => setAgentDomain(e.target.value)}
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label="Supabase secret key" hint="only while the project has more than one">
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              )}
            </Field>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!signedIn || phase === "running"}>
            {phase === "running" ? "Connecting…" : "Connect"}
          </Button>
          {!signedIn && !checking ? (
            <span className="text-muted-foreground">Sign in to the three CLIs above first.</span>
          ) : null}
        </div>
      </form>

      {error ? (
        <p role="alert" className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-danger">
          {error}
        </p>
      ) : null}
      {log ? (
        <pre
          ref={logRef}
          className="max-h-80 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap"
        >
          {log}
        </pre>
      ) : null}
      {phase === "done" ? (
        <p className="rounded-md border border-success-border bg-success-surface px-3 py-2">
          Connected. Next: start the first release, below.
        </p>
      ) : null}
    </div>
  );
}

function CliLine({
  cli,
  checking,
  onCheck,
}: {
  cli: CliStatus | null;
  checking: boolean;
  onCheck: () => void;
}) {
  if (checking) return <p className="text-muted-foreground">Checking the GitHub, Vercel and Supabase CLIs…</p>;
  if (!cli) {
    return (
      <div className="grid gap-1">
        <p className="text-danger">
          Could not check the CLIs: the local server did not answer. Is <code className="font-mono">make dev</code>{" "}
          still running?
        </p>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onCheck}>
            Check again
          </Button>
        </div>
      </div>
    );
  }
  const missing = (["gh", "vercel", "supabase"] as const).filter((key) => !cli[key]);
  return (
    <div className="grid gap-1">
      <p>
        {missing.length === 0 ? "Signed in to GitHub, Vercel and Supabase." : null}
        {cli.repo ? (
          <>
            {" "}
            Repository <code className="font-mono text-xs">{cli.repo}</code>.
          </>
        ) : (
          " This folder has no GitHub repository."
        )}
      </p>
      {missing.length > 0 ? (
        <div className="grid gap-1">
          <p>Not signed in yet. Run in a terminal, then check again:</p>
          <pre className="rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            {missing.map((key) => LOGIN[key].command).join("\n")}
          </pre>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onCheck}>
              Check again
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// What a Field hands its input so that a screen reader announces the label and the hint. A bare
// <label> next to an input names nothing: the input was read as "secure text field" alone.
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
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Label id={`${id}-label`} htmlFor={id} className="shrink-0">
          {label}
        </Label>
        {hint ? (
          <span id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      {children({ id, "aria-describedby": hint ? hintId : undefined })}
    </div>
  );
}

function Secret({
  value,
  onChange,
  ...control
}: Control & { value: string; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  const buttonId = useId();
  return (
    <div className="flex gap-1.5">
      <Input
        {...control}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Not a login form: keep the browser's password manager from filling or saving these.
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        spellCheck={false}
        className="font-mono"
        required
      />
      {/* Read as "Show Database password", not a bare "Show" next to four others. */}
      <Button
        id={buttonId}
        type="button"
        variant="outline"
        aria-labelledby={`${buttonId} ${control.id}-label`}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

function PersonPassword({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex gap-1.5">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`password, ${MIN_PASSWORD_LENGTH}+ characters`}
        autoComplete="new-password"
        aria-label={label}
      />
      <Button
        type="button"
        variant="outline"
        aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  );
}

function update(
  setPeople: React.Dispatch<React.SetStateAction<Person[]>>,
  index: number,
  patch: Partial<Person>,
) {
  setPeople((current) => current.map((person, i) => (i === index ? { ...person, ...patch } : person)));
}
