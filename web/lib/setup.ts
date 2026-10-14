// Pure logic for the Setup page: given what could be observed, which steps are done.
// No React, no Next.js and no file or network access, so `node --test` can run the tests.

import { BOOTSTRAP_SECRETS } from "./deployment.ts";

// What the person wants to end up with. The page shows one list of steps per target.
export type Target = "local" | "production";

// How production gets set up: one form on this page, which runs scripts/bootstrap.sh here with
// your `gh` sign-in, or the Bootstrap workflow in GitHub for a machine without the CLIs.
export type Via = "form" | "github";

// Which database this web server is configured for. "none" is a fresh clone: no env file yet.
export type Database = "none" | "local" | "hosted";

export type AgentHealth =
  | { reachable: true; model: string; version: string }
  | { reachable: false; reason: string };

// `null` means "could not be observed from here", which is different from "no".
export type SetupFacts = {
  onVercel: boolean;
  database: Database;
  agent: AgentHealth;
  // The GitHub repository and the names of the secrets in its production environment, read
  // with `gh` on a developer's machine. Names only; GitHub never gives a value back.
  repo: string | null;
  productionSecrets: string[] | null;
};

export type StepState = "done" | "todo" | "problem" | "manual";

export type StepId =
  | "tools"
  | "setup"
  | "dev"
  | "try-local"
  | "customise"
  | "gh"
  | "create"
  | "tokens"
  | "secrets"
  | "bootstrap"
  | "push"
  | "try-production"
  | "manage"
  | "model";

export type Step = { id: StepId; state: StepState; summary: string };

export function databaseOf(supabaseUrl: string | undefined): Database {
  if (!supabaseUrl) return "none";
  try {
    const host = new URL(supabaseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost")
      ? "local"
      : "hosted";
  } catch {
    // Unreadable configuration must not make the page claim it is a private sandbox.
    return "hosted";
  }
}

export function parseTarget(value: unknown): Target {
  return value === "production" ? "production" : "local";
}

// Where this page is being served from, in one sentence.
export function describeWhere(facts: SetupFacts): string {
  if (facts.onVercel) return "This is the deployed app.";
  switch (facts.database) {
    case "none":
      return "Nothing is set up on this machine yet. Pick what you want below.";
    case "local":
      return "This machine runs the app with its own database. Nothing here is visible to anyone else.";
    case "hosted":
      return "This machine runs the app on the hosted database. Runs started here are visible to everyone who can sign in.";
  }
}

export function buildSteps(target: Target, facts: SetupFacts, via: Via = "form"): Step[] {
  return target === "local" ? localSteps(facts) : productionSteps(facts, via);
}

export function parseVia(value: unknown): Via {
  return value === "github" ? "github" : "form";
}

function localSteps(facts: SetupFacts): Step[] {
  const { agent, database } = facts;
  const steps: Step[] = [
    {
      id: "tools",
      state: database === "none" ? "manual" : "done",
      summary:
        database === "none"
          ? "This page cannot see what is installed on your machine."
          : "Setup has run, so the tools are there.",
    },
    {
      id: "setup",
      state: database === "none" ? "todo" : "done",
      summary:
        database === "none"
          ? "No environment files yet."
          : database === "local"
            ? "Set up with a local database."
            : "Set up against the hosted database.",
    },
    agent.reachable
      ? { id: "dev", state: "done", summary: "The agent service is answering." }
      : {
          id: "dev",
          // Before setup, a silent agent is simply the next thing to do, not a fault.
          state: database === "none" ? "todo" : "problem",
          summary: agent.reason,
        },
    {
      id: "try-local",
      state: "manual",
      summary: "Sign in, start the example run and approve the step.",
    },
  ];
  if (agent.reachable) steps.push(modelStep(agent.model));
  steps.push({
    id: "customise",
    state: "manual",
    summary: "Everything about what the agent is for lives in one folder.",
  });
  return steps;
}

// Production is set up from three tokens (ADR-0005): Vercel does not let a CLI sign-in create a
// token and Supabase has no API for one, so those are pasted; everything else is automated. What
// this page can see is which secret names GitHub's production environment holds.
function productionSteps(facts: SetupFacts, via: Via): Step[] {
  // On Vercel every step has necessarily happened: this page is served by the result of them.
  const live = facts.onVercel;
  const names = facts.productionSecrets;
  const has = (name: string) => live || (names?.includes(name) ?? false);
  // The setup writes the project IDs; their presence means it ran.
  const connected = has("VERCEL_WEB_PROJECT_ID");
  const tail: Step[] = [
    {
      id: "push",
      state: live ? "done" : "manual",
      summary: live ? "This page is served by a released deployment." : "Setup starts one; every push to main starts another.",
    },
    {
      id: "try-production",
      state: "manual",
      summary: "Sign in on the production site, start the example run and approve the step.",
    },
    {
      id: "manage",
      state: "manual",
      summary: "From then on, change tokens, passwords and the model in the deployed app.",
    },
  ];

  let steps: Step[];
  if (via === "form" && (live || facts.repo !== null)) {
    steps = [
      {
        id: "tokens",
        state: connected ? "done" : "manual",
        summary: connected ? "Setup has used them." : "Vercel, Supabase and GitHub: the only things to copy.",
      },
      {
        id: "create",
        state: connected ? "done" : "todo",
        summary: connected
          ? "GitHub, Vercel and Supabase are connected. Run it again to add or replace a token."
          : "One form: it creates the Supabase project, both Vercel projects, every GitHub secret and your account.",
      },
      ...tail,
    ];
  } else if (via === "form") {
    steps = [{ id: "gh", state: "todo", summary: "This page uses your GitHub sign-in to write the secrets." }, ...tail];
  } else {
    const unknown = !live && names === null;
    const missing = BOOTSTRAP_SECRETS.filter((name) => !has(name));
    steps = [
      {
        id: "tokens",
        state: missing.length === 0 || connected ? "done" : "manual",
        summary: "Vercel, Supabase and GitHub.",
      },
      {
        id: "secrets",
        state: missing.length === 0 ? "done" : unknown ? "manual" : "todo",
        summary:
          missing.length === 0
            ? "Everything the Bootstrap workflow needs is in GitHub."
            : unknown
              ? "Could not ask GitHub (is gh signed in?)."
              : `Missing in the production environment: ${missing.join(", ")}.`,
      },
      {
        id: "bootstrap",
        state: connected ? "done" : unknown ? "manual" : "todo",
        summary: connected
          ? "Vercel and Supabase are connected."
          : "One run creates the Supabase project, the Vercel projects and your account, then releases.",
      },
      ...tail,
    ];
  }
  if (live && facts.agent.reachable) steps.push(modelStep(facts.agent.model));
  if (live && !facts.agent.reachable) {
    steps.unshift({ id: "dev", state: "problem", summary: facts.agent.reason });
  }
  return steps;
}

function modelStep(model: string): Step {
  return model === "scripted"
    ? {
        id: "model",
        state: "manual",
        summary: "Running the scripted model: no provider, no cost, a fixed example.",
      }
    : { id: "model", state: "done", summary: `Running ${model}.` };
}
