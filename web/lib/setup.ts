// Pure logic for the Setup page: given what could be observed, which steps are done.
// No React, no Next.js and no file or network access, so `node --test` can run the tests.

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
  supabaseLinked: boolean | null;
  vercelWebLinked: boolean | null;
  vercelAgentLinked: boolean | null;
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
  | "bootstrap"
  | "push"
  | "try-production"
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

function productionSteps(facts: SetupFacts): Step[] {
  // On Vercel every step has necessarily happened: this page is served by the result of them.
  const live = facts.onVercel;
  const supabaseDone = live || facts.database === "hosted" || facts.supabaseLinked === true;
  const bootstrapDone =
    live ||
    (facts.supabaseLinked === true &&
      facts.vercelWebLinked === true &&
      facts.vercelAgentLinked === true);

  const steps: Step[] = [
    {
      id: "supabase-project",
      state: supabaseDone ? "done" : "todo",
      summary: supabaseDone
        ? "A hosted Supabase project is connected to this repository."
        : "No hosted Supabase project is connected to this repository yet.",
    },
    {
      id: "tokens",
      // Tokens live where they were issued and in GitHub's secret store. Neither can be read
      // back, so after bootstrap this is inferred and before it is on trust.
      state: bootstrapDone ? "done" : "manual",
      summary: bootstrapDone
        ? "The tokens were handed to GitHub when the bootstrap script ran."
        : "This page cannot see whether you have created them.",
    },
    {
      id: "bootstrap",
      state: bootstrapDone ? "done" : "todo",
      summary: bootstrapDone
        ? "Both Vercel projects and the Supabase project are linked."
        : describeMissingLinks(facts),
    },
    {
      id: "push",
      state: live ? "done" : "manual",
      summary: live
        ? "This page is served by a released deployment."
        : "Releases happen on GitHub. This page cannot see them from your machine.",
    },
    {
      id: "try-production",
      state: "manual",
      summary: "Sign in on the production site, start the example run and approve the step.",
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

function describeMissingLinks(facts: SetupFacts): string {
  const missing: string[] = [];
  if (facts.supabaseLinked !== true) missing.push("the Supabase project");
  if (facts.vercelWebLinked !== true) missing.push("the Vercel project for web/");
  if (facts.vercelAgentLinked !== true) missing.push("the Vercel project for agent/");
  return `Not linked yet: ${missing.join(", ")}.`;
}
