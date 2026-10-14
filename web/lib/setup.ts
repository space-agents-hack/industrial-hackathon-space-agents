// Pure logic for the Setup page: given what could be observed, which steps are done.
// No React, no Next.js and no file or network access, so `node --test` can run the tests.

import { REQUIRED_SECRETS } from "./deployment.ts";

// What the person wants to end up with. The page shows one list of steps per target.
export type Target = "local" | "production";

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
  | "supabase-project"
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

export function buildSteps(target: Target, facts: SetupFacts): Step[] {
  return target === "local" ? localSteps(facts) : productionSteps(facts);
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

// The production path runs in GitHub (ADR-0005): values go into the repository's production
// environment, the Bootstrap workflow does the rest. What this page can see is which secret names
// exist there, which is enough to tell how far someone got.
function productionSteps(facts: SetupFacts): Step[] {
  // On Vercel every step has necessarily happened: this page is served by the result of them.
  const live = facts.onVercel;
  const names = facts.productionSecrets;
  const has = (name: string) => live || (names?.includes(name) ?? false);
  const unknown = !live && names === null;
  const missing = REQUIRED_SECRETS.filter((name) => !has(name));
  const tokens = ["VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "GH_CONTROL_TOKEN"];
  // The workflow writes the project IDs; their presence means it ran to that point.
  const bootstrapped = has("VERCEL_WEB_PROJECT_ID");
  // A laptop already pointed at the hosted database proves the project exists.
  const supabaseDone = has("SUPABASE_DB_PASSWORD") || facts.database === "hosted";

  const steps: Step[] = [
    {
      id: "supabase-project",
      state: supabaseDone ? "done" : unknown ? "manual" : "todo",
      summary: supabaseDone
        ? "The hosted Supabase project exists."
        : "Create it in the Supabase dashboard; the workflow cannot.",
    },
    {
      id: "tokens",
      state: tokens.every(has) ? "done" : "manual",
      summary: tokens.every(has)
        ? "GitHub has all three."
        : "Tokens stay where they were issued; this page sees them once they are in GitHub.",
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
      state: bootstrapped ? "done" : unknown ? "manual" : "todo",
      summary: bootstrapped
        ? "The workflow has connected Vercel and Supabase."
        : "One run creates the Vercel projects, the tables and your account, then releases.",
    },
    {
      id: "push",
      state: live ? "done" : "manual",
      summary: live ? "This page is served by a released deployment." : "Bootstrap starts one; every push to main starts another.",
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
