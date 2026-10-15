import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavLinksFallback } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { ProductionStatus } from "@/components/production-status";
import { ConnectGithubButton } from "@/components/connect-github-button";
import { CreateProductionForm } from "@/components/create-production-form";
import { FinishGithubButton } from "@/components/finish-github-button";
import { ReleaseProgress } from "@/components/release-progress";
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
import { gitEmail } from "@/lib/setup-commands";
import { gatherSetupFacts } from "@/lib/setup-facts";
import { showsAdmin } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import type { Tone } from "@/lib/trace";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Setup" };

// The steps to a local or a production environment. On a developer's machine this page needs
// nothing: no database, no sign-in, no agent (`make dev` on a fresh clone). It sits outside the (app) group for
// that reason, and proxy.ts lets it through. What you type into its production form goes from this
// browser to this machine and on to GitHub, Vercel and Supabase; nothing is kept here.
export default function SetupPage(props: PageProps<"/setup">) {
  return (
    <>
      <SetupHeader />
      <main className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-4 px-4 py-5">
        <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
          <Guide searchParams={props.searchParams} />
        </Suspense>
        <p className="text-xs text-muted-foreground">
          What you type here goes from this browser to this machine and on to GitHub, Vercel and
          Supabase; nothing is saved on this machine. GitHub keeps the production values where only
          the workflows can read them; this page sees only their names.
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
  // The form and the release button run local commands; they exist only under `make dev`.
  const commands = setupCommandsAvailable(
    facts.onVercel,
    process.env.NODE_ENV,
    process.env.SETUP_LOOPBACK_ONLY === "1",
  );
  const steps = buildSteps(target, facts);
  const context: Context = {
    database: facts.database,
    commands,
    repo: facts.repo,
    appSlug: facts.githubApp?.slug ?? null,
    appSettingsUrl: facts.githubApp?.settingsUrl ?? null,
    knownProjectRef: facts.projectRef,
    connected: facts.productionSecrets?.includes("VERCEL_WEB_PROJECT_ID") ?? false,
    defaultEmail: commands && target === "production" ? await gitEmail() : "",
  };
  const github = typeof params.github === "string" ? params.github : null;
  const reason = typeof params.reason === "string" ? params.reason : null;
  const plain = (value: unknown) => (typeof value === "string" && /^[\w.-]{1,40}$/.test(value) ? value : null);
  const slug = plain(params.slug);
  const installationId = typeof params.installation_id === "string" && /^\d{1,20}$/.test(params.installation_id) ? params.installation_id : null;

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
      {target === "production" && github ? (
        <GithubNotice
          outcome={github}
          reason={reason}
          slug={slug}
          owners={{ got: plain(params.owner), expected: plain(params.expected) }}
          installationId={installationId}
          release={plain(params.release)}
          ownerType={plain(params.owner_type)}
        />
      ) : null}
      <ol className="grid gap-2">
        {steps.map((step, index) => (
          <StepItem key={step.id} step={step} number={index + 1} context={context} />
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
  gh: "Sign in to GitHub on this machine",
  "github-app": "Connect GitHub",
  tokens: "Copy two tokens",
  create: "Create production",
  push: "Watch the release",
  "try-production": "Try it in production",
  manage: "Change things later",
  model: "Choose a model",
};

type Context = {
  database: Database;
  commands: boolean;
  repo: string | null;
  appSlug: string | null;
  appSettingsUrl: string | null;
  knownProjectRef: string | null;
  connected: boolean;
  defaultEmail: string;
};

function StepItem({ step, number, context }: { step: Step; number: number; context: Context }) {
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
          <Instructions id={step.id} context={context} />
        </div>
      ) : step.id === "create" && context.commands ? (
        // Run again to replace a token or to reconnect an older setup.
        <details className="mt-2 border-t pt-2">
          <summary className="cursor-pointer text-sm">Run it again</summary>
          <div className="mt-2">
            <Instructions id="create" context={context} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

function Instructions({ id, context }: { id: StepId; context: Context }) {
  const { database, commands } = context;
  switch (id) {
    case "tools":
      return (
        <p>
          <Cmd>uv</Cmd>, Node 24 or newer, the Supabase CLI, and Docker running. Docker is only for
          the local database; without it, do the production steps first and then run{" "}
          <Cmd>make setup DB=hosted</Cmd> instead of the next step. On Windows, install and run
          everything inside WSL2, with the project cloned there rather than under{" "}
          <Cmd>/mnt/c</Cmd>.
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
    case "gh":
      return (
        <>
          <Block>gh auth login</Block>
          <p>
            In a terminal, then reload this page. It writes the secrets to GitHub with your sign-in,
            including the rule that only main may deploy.
          </p>
        </>
      );
    case "github-app":
      return !commands ? (
        <p>
          Run <Cmd>make dev</Cmd> on a machine with <Cmd>gh</Cmd> signed in and open this page there.
        </p>
      ) : context.appSlug ? (
        <>
          <p>
            The app <Cmd>{context.appSlug}</Cmd> exists but is not installed.{" "}
            <Ext href={`https://github.com/apps/${context.appSlug}/installations/new`}>Install it</Ext> on
            this repository only; GitHub brings you back here.
          </p>
          <p className="text-xs text-muted-foreground">
            Or make a new one (then delete the old one at{" "}
            <Ext href={context.appSettingsUrl ?? `https://github.com/apps/${context.appSlug}`}>its settings page</Ext>):
          </p>
          <ConnectGithubButton label="Make a new app" />
        </>
      ) : (
        <>
          <ConnectGithubButton />
          <p>
            On GitHub, press <strong>Create GitHub App</strong>, then <strong>Install</strong>. Production
            gets its own key, limited to this repository: it can show and start releases and change
            its settings, never read a secret back or touch code. Nothing to copy.
          </p>
        </>
      );
    case "create":
      return commands ? (
        <CreateProductionForm
          defaultEmail={context.defaultEmail}
          knownProjectRef={context.knownProjectRef}
          connected={context.connected}
          tokenUrls={{
            vercel: "https://vercel.com/account/tokens",
            supabase: "https://supabase.com/dashboard/account/tokens",
          }}
        />
      ) : (
        <p>
          Run <Cmd>make dev</Cmd> on a machine with <Cmd>gh</Cmd> signed in and open this page there.
        </p>
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
          <li className="list-none text-muted-foreground">
            Vercel does not let a signed-in CLI create tokens, and Supabase has no API for it: these
            two are the only things to copy. Paste them in the next step.
          </li>
        </ul>
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
          Locally, set <Cmd>AGENT_MODEL</Cmd> (for example <Cmd>anthropic:claude-opus-5-5</Cmd>,{" "}
          <Cmd>openai:gpt-5.2</Cmd>, <Cmd>openrouter:…</Cmd>, <Cmd>deepseek:…</Cmd>) and that
          provider&apos;s API key in <Cmd>agent/.env</Cmd>. In production, use{" "}
          <strong>Admin, Models and limits</strong> per organisation, or <strong>Admin, Deployment</strong>{" "}
          for the default: a value set straight in Vercel is replaced by the next release.
        </p>
      );
  }
}

const GITHUB_ERRORS: Record<string, string> = {
  state: "GitHub's answer did not match this browser's request. Press Connect GitHub again.",
  code: "GitHub's answer was incomplete. Press Connect GitHub again.",
  exchange: "GitHub did not hand over the new app (the link is valid for one hour). Press Connect GitHub again.",
  install: "The installation could not be recorded. Check that gh is signed in and reload.",
};

type Owners = { got: string | null; expected: string | null };

function GithubNotice({
  outcome,
  reason,
  slug,
  owners,
  installationId,
  release,
  ownerType,
}: {
  outcome: string;
  reason: string | null;
  slug: string | null;
  owners: Owners;
  installationId: string | null;
  release: string | null;
  ownerType: string | null;
}) {
  if (outcome === "returned" && installationId) {
    return (
      <p className="rounded-md border bg-card px-3 py-2">
        GitHub is back from the install page. <FinishGithubButton installationId={installationId} />
      </p>
    );
  }
  if (outcome === "requested") {
    return (
      <p className="rounded-md border bg-card px-3 py-2">
        GitHub sent an installation request to an owner of the organisation. Once they approve it,
        press Install again from this step.
      </p>
    );
  }
  if (outcome === "installed") {
    return (
      <p className="rounded-md border border-success-border bg-success-surface px-3 py-2">
        GitHub is connected.{" "}
        {release === "started"
          ? "A release is giving production the app's key: follow it below."
          : release === "failed"
            ? "Production needs one release to receive the app's key: push to main, or start one below."
            : "The release that Create production starts gives production the app's key."}
      </p>
    );
  }
  return (
    <p role="alert" className="rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-danger">
      {reason === "owner" && slug ? (
        <>
          The app {slug} was created under {owners.got ?? "another account"}, the GitHub account this
          browser is signed in to, but the repository belongs to {owners.expected ?? "someone else"}.
          While still signed in as {owners.got ?? "that account"}, delete {slug} at{" "}
          <Ext href={`https://github.com/settings/apps/${slug}`}>its settings page</Ext>; then sign in
          to GitHub as {owners.expected ?? "the repository's owner"} and press Connect GitHub again.
        </>
      ) : reason === "store" && slug ? (
        <>
          The app {slug} was created, but its key could not be stored in GitHub: gh may be signed
          out, or not an admin of this repository. Delete it at{" "}
          <Ext
            href={
              ownerType === "Organization" && owners.got
                ? `https://github.com/organizations/${owners.got}/settings/apps/${slug}`
                : `https://github.com/settings/apps/${slug}`
            }
          >
            its settings page
          </Ext>{" "}
          and press Connect GitHub again.
        </>
      ) : (
        (GITHUB_ERRORS[reason ?? ""] ?? "Connecting GitHub did not finish. Press Connect GitHub again.")
      )}
    </p>
  );
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
