import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavLinksFallback } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { ProductionStatus } from "@/components/production-status";
import { ReleaseProgress } from "@/components/release-progress";
import { ToneBadge } from "@/components/status-badge";
import { APP_NAME, LOCAL_DEMO_USER } from "@/lib/config";
import { CONTROL_TOKEN_PERMISSIONS, controlTokenUrl } from "@/lib/deployment";
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
          This page asks for nothing secret. Production values go into GitHub, where only the
          workflows can read them; this page sees only their names.
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
            repo={facts.repo}
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
  tokens: "Create three tokens",
  secrets: "Put them in GitHub",
  bootstrap: "Run the Bootstrap workflow",
  push: "Watch the release",
  "try-production": "Try it in production",
  manage: "Change things later",
  model: "Choose a model",
};

function StepItem({
  step,
  number,
  database,
  commands,
  repo,
}: {
  step: Step;
  number: number;
  database: Database;
  commands: boolean;
  repo: string | null;
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
          <Instructions id={step.id} database={database} commands={commands} repo={repo} />
        </div>
      ) : null}
    </li>
  );
}

function Instructions({
  id,
  database,
  commands,
  repo,
}: {
  id: StepId;
  database: Database;
  commands: boolean;
  repo: string | null;
}) {
  // Links into this repository's GitHub settings; without a known repository, the plain path.
  const github = (path: string) => (repo ? `https://github.com/${repo}/${path}` : null);
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
            Vercel: <Ext href="https://vercel.com/account/tokens">vercel.com/account/tokens</Ext>,
            scoped to the team that will own the projects.
          </li>
          <li>
            Supabase:{" "}
            <Ext href="https://supabase.com/dashboard/account/tokens">supabase.com/dashboard/account/tokens</Ext>.
          </li>
          <li>
            GitHub: <Ext href={controlTokenUrl(repo ?? "", APP_NAME)}>a fine-grained token</Ext> for this
            repository only, with {CONTROL_TOKEN_PERMISSIONS}. The app keeps it to change these
            values later; it cannot read them back or change code.
          </li>
        </ul>
      );
    case "secrets":
      return (
        <>
          <p>
            In GitHub, open{" "}
            {github("settings/environments") ? (
              <Ext href={github("settings/environments")!}>Settings, Environments</Ext>
            ) : (
              "Settings, Environments"
            )}
            , then <strong>production</strong> (create it with that name if it is not there), and add
            these environment secrets:
          </p>
          <ul className="list-disc pl-5">
            <li>
              <Cmd>VERCEL_TOKEN</Cmd>, <Cmd>SUPABASE_ACCESS_TOKEN</Cmd>, <Cmd>GH_CONTROL_TOKEN</Cmd>: the
              three tokens
            </li>
            <li>
              <Cmd>SUPABASE_DB_PASSWORD</Cmd>: the database password
            </li>
            <li>
              <Cmd>ADMIN_PASSWORD</Cmd>: the password you will sign in with, 12+ characters. The
              workflow deletes it from GitHub once your account exists.
            </li>
          </ul>
        </>
      );
    case "bootstrap":
      return (
        <>
          <p>
            Open{" "}
            {github("actions/workflows/bootstrap.yml") ? (
              <Ext href={github("actions/workflows/bootstrap.yml")!}>Actions, Bootstrap</Ext>
            ) : (
              "Actions, Bootstrap"
            )}
            , press <strong>Run workflow</strong>, and fill in the Supabase <strong>Project ID</strong>{" "}
            and <strong>your email</strong>. Leave the rest empty.
          </p>
          <p>
            It creates the two Vercel projects, the database tables and your account (platform
            admin), then starts a release. Safe to run again.
          </p>
        </>
      );
    case "push":
      return (
        <>
          <p>
            {commands ? "Start one here or push to main. " : null}
            The Deploy workflow runs the checks, deploys, smoke-tests and promotes. If a step
            fails, production keeps the previous version; <Cmd>docs/deploy.md</Cmd> says what each
            failure means.
          </p>
          {commands ? (
            <ReleaseProgress
              endpoint="/api/setup/releases"
              startUrl="/api/setup/release"
              notConfigured={
                <p className="text-muted-foreground">
                  Sign in to GitHub with <Cmd>gh auth login</Cmd> to see releases here.
                </p>
              }
            />
          ) : (
            <Block>git push</Block>
          )}
        </>
      );
    case "try-production":
      return commands ? (
        <ProductionStatus />
      ) : (
        <p>
          Open the web project&apos;s domain from Vercel, sign in with the email and password you
          gave the workflow, start the first example run and approve the step.
        </p>
      );
    case "manage":
      return (
        <p>
          In the deployed app, <strong>Admin, Deployment</strong> replaces any token, the database
          password or the default model, and applies it; <strong>Admin, Releases</strong> follows
          and starts releases; <strong>Admin, People</strong> and <strong>Providers</strong> handle
          accounts and model keys. Nothing needs this machine.
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
