import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavLinksFallback } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { ConnectForm } from "@/components/connect-form";
import { ProductionStatus } from "@/components/production-status";
import { ReleaseButton } from "@/components/release-button";
import { ToneBadge } from "@/components/status-badge";
import { APP_NAME, LOCAL_DEMO_USER } from "@/lib/config";
import {
  type Database,
  type Step,
  type StepId,
  type StepState,
  type Target,
  buildSteps,
  describeWhere,
  parseTarget,
} from "@/lib/setup";
import { setupCommandsAvailable } from "@/lib/local-request";
import { gatherSetupFacts } from "@/lib/setup-facts";
import { showsAdmin } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import type { Tone } from "@/lib/trace";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Setup" };

// The steps to a local or a production environment. On a developer's machine this page needs
// nothing: no database, no sign-in, no agent (`make dev` on a fresh clone). It sits outside the (app) group for
// that reason, and proxy.ts lets it through. It never asks for a password, a token or a key.
export default function SetupPage(props: PageProps<"/setup">) {
  return (
    <>
      <SetupHeader />
      <main className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-4 px-4 py-5">
        <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
          <Guide searchParams={props.searchParams} />
        </Suspense>
        <p className="text-xs text-muted-foreground">
          What you type here goes to this machine only, and from there to GitHub, Vercel and
          Supabase. Nothing is saved in a file of the repository. The form only works while{" "}
          <code className="font-mono">make dev</code> runs on this machine, never on the deployed app.
        </p>
      </main>
    </>
  );
}

// The same frame as the app's header, always rendered as it is; only the parts that depend on
// the session are filled in per request, each inside its own Suspense. Rendering the whole header
// from one per-request component made the development server reload the page in a loop.
function SetupHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-3 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        <Suspense fallback={<NavLinksFallback />}>
          <SetupNav />
        </Suspense>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <Suspense fallback={null}>
            <SetupAccount />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

// Without the Supabase variables there is no session to look for, and asking would throw.
async function sessionUser() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }
  return getSessionUser(await createClient()).catch(() => null);
}

async function SetupNav() {
  if (!(await sessionUser())) return <span className="text-xs text-muted-foreground">Setup</span>;
  const { access, current } = await getCurrentOrg();
  return <NavLinks showAdmin={showsAdmin(access, current)} />;
}

async function SetupAccount() {
  const user = await sessionUser();
  if (!user) {
    // /login, not /: signed out, / comes straight back here.
    return (
      <Link
        href="/login"
        className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Sign in
      </Link>
    );
  }
  return (
    <>
      {user.email ? (
        <span className="hidden truncate text-xs text-muted-foreground md:inline">{user.email}</span>
      ) : null}
      <SignOutButton />
    </>
  );
}

async function Guide({ searchParams }: { searchParams: PageProps<"/setup">["searchParams"] }) {
  const [params, facts] = await Promise.all([searchParams, gatherSetupFacts()]);
  // The deployed app has only one story to tell.
  const target: Target = facts.onVercel ? "production" : parseTarget(params.env);
  const steps = buildSteps(target, facts);
  // The form and the release button run local commands; they exist only under `next dev`.
  const commands = setupCommandsAvailable(
    facts.onVercel,
    process.env.NODE_ENV,
    process.env.SETUP_LOOPBACK_ONLY === "1",
  );

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
          <StepItem
            key={step.id}
            step={step}
            number={index + 1}
            database={facts.database}
            commands={commands}
          />
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
  customise: "Make it yours",
  "supabase-project": "Create the Supabase project",
  tokens: "Create two access tokens",
  bootstrap: "Connect GitHub, Vercel and Supabase",
  push: "Start the first release",
  "try-production": "Try it in production",
  model: "Choose a model",
};

function StepItem({
  step,
  number,
  database,
  commands,
}: {
  step: Step;
  number: number;
  database: Database;
  commands: boolean;
}) {
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
      {step.state !== "done" ? (
        <div className="mt-2 grid gap-2 border-t pt-2">
          <Instructions id={step.id} database={database} commands={commands} />
        </div>
      ) : step.id === "bootstrap" && commands ? (
        <details className="mt-2 border-t pt-2">
          <summary className="cursor-pointer text-sm">Check, change or rotate credentials</summary>
          <div className="mt-2 grid gap-2">
            <Rotation />
            <ConnectForm />
          </div>
        </details>
      ) : null}
    </li>
  );
}

function Instructions({
  id,
  database,
  commands,
}: {
  id: StepId;
  database: Database;
  commands: boolean;
}) {
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
            creates the demo user. Then stop <Cmd>make dev</Cmd> (Ctrl-C) and run it again.
          </p>
        </>
      );
    case "dev":
      return (
        <>
          <Block>make dev</Block>
          <p>
            The same command that showed you this page. Once setup has run, it also starts the
            database and the agent. If it is already running, stop it (Ctrl-C) and run it again.
          </p>
        </>
      );
    case "try-local":
      // /login works in both states: signed out it asks, signed in it goes straight to Runs.
      return (
        <p>
          <Link href="/login" className="text-primary underline underline-offset-2">Open the app</Link>
          {database === "hosted" ? (
            " (sign in with your own account if asked)"
          ) : (
            <>
              {" "}
              (if asked, sign in as <Cmd>{LOCAL_DEMO_USER.email}</Cmd> with password{" "}
              <Cmd>{LOCAL_DEMO_USER.password}</Cmd>)
            </>
          )}
          . Start the first example run and approve the step.
        </p>
      );
    case "customise":
      return (
        <>
          <p>
            Edit the files in <Cmd>agent/agent_service/domain/</Cmd> and nothing outside it:
          </p>
          <ul className="list-disc pl-5">
            <li>
              <Cmd>systems.py</Cmd>: calls to the real systems or data
            </li>
            <li>
              <Cmd>tools.py</Cmd>: what the model may call; mark every write{" "}
              <Cmd>requires_approval=True</Cmd>
            </li>
            <li>
              <Cmd>prompt.md</Cmd>: how the agent should work and report
            </li>
            <li>
              <Cmd>scripted.py</Cmd>: a scripted run of your task, for tests and demos without a
              model
            </li>
          </ul>
          <p>
            Run <Cmd>make check</Cmd> before you push.
          </p>
        </>
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
            When the project is ready, copy its <strong>Project ID</strong>: the code after{" "}
            <Cmd>/project/</Cmd> in the dashboard&apos;s address, also under Project Settings, General.
            It is a Supabase value; Vercel needs only the token.
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
      return commands ? (
        <>
          <ConnectForm />
          <p className="text-xs text-muted-foreground">
            The form runs <Cmd>scripts/bootstrap.sh</Cmd> on this machine with your answers. The
            same script also works on its own in a terminal.
          </p>
        </>
      ) : (
        <>
          {process.env.NODE_ENV === "development" ? (
            <p>
              To fill this in on this page instead, stop the server (Ctrl-C) and start it with{" "}
              <Cmd>make dev</Cmd>. Until then, run the script in a terminal:
            </p>
          ) : null}
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
          {commands ? <ReleaseButton /> : <Block>git push</Block>}
          <p>
            {commands ? "Or push to main. " : null}
            The Deploy workflow runs the checks, deploys, smoke-tests and promotes. If a step
            fails, production keeps the previous version; <Cmd>docs/deploy.md</Cmd> says what each
            failure means.
          </p>
        </>
      );
    case "try-production":
      return commands ? (
        <ProductionStatus />
      ) : (
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

// Where a new value comes from. The form below is prefilled from .env.setup.local; change a field,
// press Connect, then start a release: environment changes reach only new deployments.
function Rotation() {
  return (
    <div className="grid gap-1 text-sm">
      <p>
        Press <strong>Show</strong> in a field to check a value. To change one, edit it, press <strong>Connect</strong>, then{" "}
        <strong>Start the release</strong>.
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>
          Vercel or Supabase token: create a new one (links in the form), paste it, Connect, then
          delete the old one where you created it.
        </li>
        <li>
          Database password: reset it in Supabase, Project Settings, Database, then paste it here.
        </li>
        <li>
          Supabase API keys: create a new secret key in Supabase, Project Settings, API Keys. Connect
          reads the keys itself; delete the old key after the release.
        </li>
        <li>A person&apos;s password: type the new one next to their email.</li>
        <li>
          The secret between the web and the agent is kept between runs; tick Renew to replace it.
        </li>
      </ul>
    </div>
  );
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
