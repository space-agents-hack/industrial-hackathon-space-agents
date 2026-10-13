// Pure logic for the Setup page: given what could be observed, which steps are done.
// No React, no Next.js and no file or network access, so `node --test` can run the tests.

// Three, not two: a laptop can run the app against the hosted database (`make setup DB=hosted`).
// Calling that "local" would hide that its runs are stored where everyone can see them.
export type Environment = "local" | "local-hosted" | "production";

export type AgentHealth =
  | { reachable: true; model: string; version: string }
  | { reachable: false; reason: string };

// `null` means "could not be observed from here", which is different from "no".
export type SetupFacts = {
  environment: Environment;
  agent: AgentHealth;
  supabaseLinked: boolean | null;
  vercelWebLinked: boolean | null;
  vercelAgentLinked: boolean | null;
};

export type StepState = "done" | "todo" | "problem" | "manual";

export type StepId =
  | "local-app"
  | "agent"
  | "model"
  | "supabase-project"
  | "tokens"
  | "bootstrap"
  | "release"
  | "production-check";

export type Step = { id: StepId; state: StepState; summary: string };

export function environmentOf(supabaseUrl: string, onVercel: boolean): Environment {
  if (onVercel) return "production";
  try {
    const host = new URL(supabaseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost")
      ? "local"
      : "local-hosted";
  } catch {
    // Unreadable configuration must not make the page claim it is a private sandbox.
    return "local-hosted";
  }
}

export const ENVIRONMENT_NOTE: Record<Environment, string> = {
  local:
    "This is your machine with its own database (Docker). Nothing you do here is visible to anyone else.",
  "local-hosted":
    "This is your machine using the hosted database. Runs you start here are stored in the cloud and visible to everyone who can sign in.",
  production: "This is the deployed app.",
};

export function isScripted(model: string): boolean {
  return model === "scripted";
}

export function buildSteps(facts: SetupFacts): Step[] {
  const { environment, agent } = facts;
  const inProduction = environment === "production";
  const steps: Step[] = [];

  if (!inProduction) {
    steps.push({
      id: "local-app",
      state: "done",
      summary:
        environment === "local"
          ? "The web, the local database and your sign-in work: you are reading this page."
          : "The web and your sign-in work against the hosted database: you are reading this page.",
    });
  }

  steps.push(
    agent.reachable
      ? { id: "agent", state: "done", summary: "The web server reached the agent service." }
      : { id: "agent", state: "problem", summary: agent.reason },
  );

  if (agent.reachable) {
    steps.push(
      isScripted(agent.model)
        ? {
            id: "model",
            state: "todo",
            summary: "Running the scripted model: no provider, no cost, a fixed example.",
          }
        : { id: "model", state: "done", summary: `Running ${agent.model}.` },
    );
  }

  // In production every cloud step has necessarily happened: this page is being served by the
  // result of them.
  // A laptop already talking to the hosted database is past this step too, linked or not.
  const supabaseDone =
    inProduction || environment === "local-hosted" || facts.supabaseLinked === true;
  steps.push({
    id: "supabase-project",
    state: supabaseDone ? "done" : "todo",
    summary: supabaseDone
      ? "A hosted Supabase project is linked to this repository."
      : "No hosted Supabase project is linked to this repository yet.",
  });

  const bootstrapDone =
    inProduction ||
    (facts.supabaseLinked === true &&
      facts.vercelWebLinked === true &&
      facts.vercelAgentLinked === true);

  steps.push({
    id: "tokens",
    // Tokens live in the accounts that issued them and in GitHub's secret store. Neither can be
    // read back, so once bootstrap has run this is inferred, and before that it is on trust.
    state: bootstrapDone ? "done" : "manual",
    summary: bootstrapDone
      ? "The tokens were handed to GitHub when the bootstrap script ran."
      : "Two access tokens are needed. This page cannot see whether you have created them.",
  });

  steps.push({
    id: "bootstrap",
    state: bootstrapDone ? "done" : "todo",
    summary: bootstrapDone
      ? "Both Vercel projects and the Supabase project are linked."
      : describeMissingLinks(facts),
  });

  steps.push({
    id: "release",
    state: inProduction ? "done" : "manual",
    summary: inProduction
      ? "This page is served by a released deployment."
      : "Releases happen on GitHub. This page cannot see them from your machine.",
  });

  steps.push({
    id: "production-check",
    state: "manual",
    summary: inProduction
      ? "Start the example run and approve the step. It is the one check that uses a real browser."
      : "After the first release: open the production site, run the example, approve the step.",
  });

  return steps;
}

function describeMissingLinks(facts: SetupFacts): string {
  const missing: string[] = [];
  if (facts.supabaseLinked !== true) missing.push("the Supabase project");
  if (facts.vercelWebLinked !== true) missing.push("the Vercel project for web/");
  if (facts.vercelAgentLinked !== true) missing.push("the Vercel project for agent/");
  return `Not linked yet: ${missing.join(", ")}.`;
}

export function countRemaining(steps: readonly Step[]): number {
  return steps.filter((step) => step.state === "todo" || step.state === "problem").length;
}
