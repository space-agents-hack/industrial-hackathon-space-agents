import type { Metadata } from "next";
import { Suspense } from "react";

import { ToneBadge } from "@/components/status-badge";
import { type Step, type StepId, type StepState, buildSteps, countRemaining } from "@/lib/setup";
import { gatherSetupFacts } from "@/lib/setup-facts";
import type { Tone } from "@/lib/trace";

export const metadata: Metadata = { title: "Setup" };

// The path from a fresh clone to a production deployment, with the steps this page can observe
// checked for you. It never asks for a password, a token or a key: see "Where secrets go".
export default function SetupPage() {
  return (
    <div className="grid max-w-3xl gap-5">
      <header className="grid gap-1">
        <h1 className="text-base font-semibold">Setup</h1>
        <p className="text-muted-foreground">
          From a fresh clone to a deployed agent. Steps this page can observe are checked
          automatically; the rest are marked as yours to confirm.
        </p>
      </header>
      <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
        <Checklist />
      </Suspense>
      <SecretsNote />
    </div>
  );
}

async function Checklist() {
  const facts = await gatherSetupFacts();
  const steps = buildSteps(facts);
  const remaining = countRemaining(steps);
  const agent = facts.agent;

  return (
    <section className="grid gap-3">
      <p className="rounded-md border bg-card px-3 py-2">
        You are looking at the <strong>{facts.environment}</strong> environment.{" "}
        {remaining === 0
          ? "Nothing this page can check is outstanding."
          : `${remaining} step${remaining === 1 ? "" : "s"} still to do.`}
        {agent.reachable ? (
          <>
            {" "}
            Agent model <code className="font-mono text-xs">{agent.model}</code>, version{" "}
            <code className="font-mono text-xs">{agent.version.slice(0, 12)}</code>.
          </>
        ) : null}
      </p>
      <ol className="grid gap-2">
        {steps.map((step, index) => (
          <StepItem key={step.id} step={step} number={index + 1} />
        ))}
      </ol>
    </section>
  );
}

const STATE_META: Record<StepState, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "green" },
  todo: { label: "To do", tone: "amber" },
  problem: { label: "Problem", tone: "red" },
  manual: { label: "Yours to confirm", tone: "neutral" },
};

const TITLES: Record<StepId, string> = {
  "local-app": "Run it locally",
  agent: "Agent service",
  model: "Choose a model",
  "supabase-project": "Create the Supabase project",
  tokens: "Create two access tokens",
  bootstrap: "Run the bootstrap script",
  release: "Push and watch the release",
  "production-check": "Try it in production",
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
      {step.state === "done" && step.id !== "model" ? null : <Instructions id={step.id} />}
    </li>
  );
}

function Instructions({ id }: { id: StepId }) {
  switch (id) {
    case "local-app":
      return null;
    case "agent":
      return (
        <Body>
          <p>
            Locally, <Cmd>make dev</Cmd> starts the agent on port 8000 together with the web. In
            production, check that <Cmd>AGENT_URL</Cmd> in the web&apos;s Vercel project is the
            agent project&apos;s domain and that the agent&apos;s last deployment is healthy.
          </p>
        </Body>
      );
    case "model":
      return (
        <Body>
          <p>
            The model is one setting, <Cmd>AGENT_MODEL</Cmd>, written as provider:model, plus that
            provider&apos;s API key. Nothing in the code changes.
          </p>
          <ul className="list-disc pl-5">
            <li>
              <Cmd>anthropic:claude-opus-5-5</Cmd> with <Cmd>ANTHROPIC_API_KEY</Cmd>
            </li>
            <li>
              <Cmd>openai:gpt-5.2</Cmd> with <Cmd>OPENAI_API_KEY</Cmd>
            </li>
            <li>
              <Cmd>openrouter:anthropic/claude-sonnet-4.6</Cmd> with <Cmd>OPENROUTER_API_KEY</Cmd>
            </li>
            <li>
              <Cmd>deepseek:deepseek-v4-flash</Cmd> with <Cmd>DEEPSEEK_API_KEY</Cmd>
            </li>
          </ul>
          <p>
            Locally, edit <Cmd>agent/.env</Cmd> and restart <Cmd>make dev</Cmd>. In production, set
            both variables in the agent&apos;s Vercel project and re-run the Deploy workflow. Keep{" "}
            <Cmd>scripted</Cmd> until the pipeline has released once: it separates &quot;the
            deployment is broken&quot; from &quot;the model key is wrong&quot;.
          </p>
        </Body>
      );
    case "supabase-project":
      return (
        <Body>
          <p>
            Create it at <Ext href="https://supabase.com/dashboard/new">supabase.com/dashboard/new</Ext>
            , on its own. It does not need to know about Vercel; the bootstrap script connects the
            two. Skip the Supabase integration inside Vercel: it sets different variable names.
          </p>
          <ul className="list-disc pl-5">
            <li>Name: the name of this repository.</li>
            <li>Region: the one closest to where it will be used and to the Vercel region.</li>
            <li>
              Database password: press <strong>Generate a password</strong> and save it in your
              password manager. Do not invent one.
            </li>
          </ul>
          <p>
            You will type that password once, into the bootstrap script. Afterwards copy the
            project reference from Settings, General.
          </p>
        </Body>
      );
    case "tokens":
      return (
        <Body>
          <ul className="list-disc pl-5">
            <li>
              Supabase:{" "}
              <Ext href="https://supabase.com/dashboard/account/tokens">
                supabase.com/dashboard/account/tokens
              </Ext>
              . It lets the release workflow apply migrations.
            </li>
            <li>
              Vercel: <Ext href="https://vercel.com/account/tokens">vercel.com/account/tokens</Ext>,
              scoped to the team that will own the projects. It lets the workflow deploy.
            </li>
          </ul>
          <p>Each is shown once. Keep the tab open until the bootstrap script has asked for it.</p>
        </Body>
      );
    case "bootstrap":
      return (
        <Body>
          <p>In a terminal, from the repository root:</p>
          <Block>scripts/bootstrap.sh</Block>
          <p>It asks, in this order:</p>
          <ol className="list-decimal pl-5">
            <li>A name for the two Vercel projects (Enter for the repository name).</li>
            <li>The Vercel token.</li>
            <li>The agent&apos;s production domain (Enter for the one it found).</li>
            <li>The Supabase project reference, database password and access token.</li>
            <li>Whether to apply the migrations now (answer y the first time).</li>
            <li>The model (Enter for scripted on the first run).</li>
            <li>The email and password of each person who should be able to sign in.</li>
          </ol>
          <p>
            It reads the Supabase API keys itself, turns new sign-ups off, and is safe to run
            again if it stops half-way.
          </p>
        </Body>
      );
    case "release":
      return (
        <Body>
          <Block>git push</Block>
          <p>
            Open the Actions tab of the repository on GitHub. The Deploy workflow runs the checks,
            applies migrations, deploys the agent and the web without the production domain,
            smoke-tests them and then promotes them. If a step fails, production keeps the
            previous version; <Cmd>docs/deploy.md</Cmd> says what each failure means.
          </p>
        </Body>
      );
    case "production-check":
      return (
        <Body>
          <p>
            Sign in on the production site, start the first example run and approve the step. No
            automated test clicks through the real site, so this is the check that does.
          </p>
        </Body>
      );
  }
}

function SecretsNote() {
  return (
    <section className="grid gap-1 rounded-md border bg-card px-3 py-2.5">
      <h2 className="font-medium">Where secrets go</h2>
      <p className="text-muted-foreground">
        Nowhere on this page, and in no file of the repository. Passwords, tokens and keys are
        typed into hidden prompts of <Cmd>scripts/bootstrap.sh</Cmd>, which hands them straight to
        GitHub and Vercel from your own machine. A web form would have to send them to a server
        first, and that is one more place for them to leak.
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>
          Database password: GitHub secret <Cmd>SUPABASE_DB_PASSWORD</Cmd>. Only the release
          workflow uses it, to apply migrations. The running app never does.
        </li>
        <li>
          Supabase secret key and the model provider&apos;s key: the agent&apos;s Vercel project.
        </li>
        <li>Supabase publishable key: the web&apos;s Vercel project. It is safe in a browser.</li>
        <li>
          Lost one? Create a new one where it was issued and run the bootstrap script again.
        </li>
      </ul>
    </section>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 grid gap-2 border-t pt-2">{children}</div>;
}

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
