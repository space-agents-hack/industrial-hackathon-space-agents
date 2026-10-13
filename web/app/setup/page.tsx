import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ToneBadge } from "@/components/status-badge";
import { APP_NAME } from "@/lib/config";
import {
  type Step,
  type StepId,
  type StepState,
  type Target,
  buildSteps,
  describeWhere,
  parseTarget,
} from "@/lib/setup";
import { gatherSetupFacts } from "@/lib/setup-facts";
import type { Tone } from "@/lib/trace";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Setup" };

// The steps to a local or a production environment. On a developer's machine this page needs
// nothing: no database, no sign-in, no agent (`make guide`). It sits outside the (app) group for
// that reason, and proxy.ts lets it through. It never asks for a password, a token or a key.
export default function SetupPage(props: PageProps<"/setup">) {
  return (
    <>
      <header className="border-b bg-card">
        <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-3 px-4">
          <span className="font-semibold tracking-tight">{APP_NAME}</span>
          <span className="text-xs text-muted-foreground">Setup</span>
          <Link href="/" className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            Open the app
          </Link>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-4 px-4 py-5">
        <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
          <Guide searchParams={props.searchParams} />
        </Suspense>
        <p className="text-xs text-muted-foreground">
          Secrets are never typed into this page or saved in a file of the repository. The
          bootstrap script asks for them in hidden prompts and hands them to GitHub and Vercel.
        </p>
      </main>
    </>
  );
}

async function Guide({ searchParams }: { searchParams: PageProps<"/setup">["searchParams"] }) {
  const [params, facts] = await Promise.all([searchParams, gatherSetupFacts()]);
  // The deployed app has only one story to tell.
  const target: Target = facts.onVercel ? "production" : parseTarget(params.env);
  const steps = buildSteps(target, facts);

  return (
    <>
      <p className="rounded-md border bg-card px-3 py-2">
        {describeWhere(facts)}
        {facts.agent.reachable ? (
          <>
            {" "}
            Agent model <code className="font-mono text-xs">{facts.agent.model}</code>.
          </>
        ) : null}
      </p>
      {facts.onVercel ? null : (
        <nav className="flex gap-1.5" aria-label="What do you want to set up?">
          <TargetLink current={target} target="local" label="Run it on this machine" />
          <TargetLink current={target} target="production" label="Deploy to production" />
        </nav>
      )}
      <ol className="grid gap-2">
        {steps.map((step, index) => (
          <StepItem key={step.id} step={step} number={index + 1} />
        ))}
      </ol>
    </>
  );
}

function TargetLink({ current, target, label }: { current: Target; target: Target; label: string }) {
  const active = current === target;
  return (
    <Link
      href={`/setup?env=${target}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
      )}
    >
      {label}
    </Link>
  );
}

const STATE_META: Record<StepState, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "green" },
  todo: { label: "To do", tone: "amber" },
  problem: { label: "Problem", tone: "red" },
  manual: { label: "Yours to confirm", tone: "neutral" },
};

const TITLES: Record<StepId, string> = {
  tools: "Install the tools",
  setup: "Run setup",
  dev: "Start the app",
  "try-local": "Try it",
  "supabase-project": "Create the Supabase project",
  tokens: "Create two access tokens",
  bootstrap: "Run the bootstrap script",
  push: "Push",
  "try-production": "Try it in production",
  model: "Choose a model",
};

function StepItem({ step, number }: { step: Step; number: number }) {
  const meta = STATE_META[step.state];
  return (
    <li className="rounded-md border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">{number}</span>
        <h2 className="font-medium">{TITLES[step.id]}</h2>
        <ToneBadge tone={meta.tone} className="ml-auto">
          {meta.label}
        </ToneBadge>
      </div>
      <p className="mt-1 text-muted-foreground">{step.summary}</p>
      {step.state === "done" ? null : (
        <div className="mt-2 grid gap-2 border-t pt-2">
          <Instructions id={step.id} />
        </div>
      )}
    </li>
  );
}

function Instructions({ id }: { id: StepId }) {
  switch (id) {
    case "tools":
      return (
        <p>
          <Cmd>uv</Cmd>, Node 24 or newer, the Supabase CLI, and Docker running. Docker is only for
          the local database; without it, do the production steps first and then run{" "}
          <Cmd>make setup DB=hosted</Cmd> instead of the next step.
        </p>
      );
    case "setup":
      return (
        <>
          <Block>make setup</Block>
          <p>
            Installs the dependencies, starts the local database, writes the environment files and
            creates a demo user. It prints that user&apos;s email and password.
          </p>
        </>
      );
    case "dev":
      return (
        <>
          <Block>make dev</Block>
          <p>
            Starts the agent on port 8000 and the web on port 3000. If you opened this page with{" "}
            <Cmd>make guide</Cmd>, stop that first (Ctrl-C): both use port 3000.
          </p>
        </>
      );
    case "try-local":
      return (
        <p>
          Open <Link href="/" className="text-primary underline underline-offset-2">the app</Link>,
          sign in with the demo user, start the first example run and approve the step.
        </p>
      );
    case "supabase-project":
      return (
        <ul className="list-disc pl-5">
          <li>
            Go to <Ext href="https://supabase.com/dashboard/new">supabase.com/dashboard/new</Ext>.
            Not through Vercel&apos;s Supabase integration.
          </li>
          <li>Name it like the repository and pick the region closest to you.</li>
          <li>
            Click <strong>Generate a password</strong> and copy it.
          </li>
          <li>
            When the project is ready, copy its <strong>Project ID</strong> from Settings, General.
          </li>
        </ul>
      );
    case "tokens":
      return (
        <ul className="list-disc pl-5">
          <li>
            Supabase:{" "}
            <Ext href="https://supabase.com/dashboard/account/tokens">
              supabase.com/dashboard/account/tokens
            </Ext>
          </li>
          <li>
            Vercel: <Ext href="https://vercel.com/account/tokens">vercel.com/account/tokens</Ext>,
            scoped to the team that will own the projects
          </li>
        </ul>
      );
    case "bootstrap":
      return (
        <>
          <Block>scripts/bootstrap.sh</Block>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">It asks</th>
                <th className="py-1 font-medium">You answer</th>
              </tr>
            </thead>
            <tbody className="align-top [&_td]:border-t [&_td]:py-1 [&_td:first-child]:pr-3">
              {BOOTSTRAP_ANSWERS.map(([question, answer]) => (
                <tr key={question}>
                  <td>{question}</td>
                  <td>{answer}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Nothing appears on screen when you paste a token or password. Needs the <Cmd>gh</Cmd>,{" "}
            <Cmd>vercel</Cmd> and <Cmd>supabase</Cmd> CLIs signed in. Safe to run again.
          </p>
        </>
      );
    case "push":
      return (
        <>
          <Block>git push</Block>
          <p>
            Watch the Deploy workflow in the repository&apos;s Actions tab. If a step fails,
            production keeps the previous version; <Cmd>docs/deploy.md</Cmd> says what each
            failure means.
          </p>
        </>
      );
    case "try-production":
      return (
        <p>
          Open the web project&apos;s domain from Vercel, sign in with a user you created in the
          bootstrap script, start the first example run and approve the step.
        </p>
      );
    case "model":
      return (
        <p>
          Set <Cmd>AGENT_MODEL</Cmd> (for example <Cmd>anthropic:claude-opus-5-5</Cmd>,{" "}
          <Cmd>openai:gpt-5.2</Cmd>, <Cmd>openrouter:…</Cmd>, <Cmd>deepseek:…</Cmd>) and that
          provider&apos;s API key: in <Cmd>agent/.env</Cmd> locally, or in the agent&apos;s Vercel
          project in production, then re-run the Deploy workflow.
        </p>
      );
  }
}

const BOOTSTRAP_ANSWERS: [string, string][] = [
  ["Name for the Vercel projects", "Enter"],
  ["Vercel token", "paste it"],
  ["Production domain of the agent", "Enter"],
  ["Project reference", "paste the Project ID"],
  ["Database password", "paste it"],
  ["Supabase access token", "paste it"],
  ["Apply the migrations now?", "y"],
  ["AGENT_MODEL", "Enter (scripted model for the first deploy)"],
  ["Email of a user to create", "an email, then a password of 12+ characters; empty to finish"],
];

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

function Block({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
      {children}
    </pre>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  );
}
