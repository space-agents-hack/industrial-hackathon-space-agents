import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SetupFacts,
  type StepId,
  type StepState,
  buildSteps,
  countRemaining,
  environmentOf,
} from "./setup.ts";

const fresh: SetupFacts = {
  environment: "local",
  agent: { reachable: true, model: "scripted", version: "unknown" },
  supabaseLinked: false,
  vercelWebLinked: false,
  vercelAgentLinked: false,
};

function states(facts: SetupFacts): Partial<Record<StepId, StepState>> {
  return Object.fromEntries(buildSteps(facts).map((step) => [step.id, step.state]));
}

test("environmentOf: a laptop on the hosted database is its own case, not local", () => {
  assert.equal(environmentOf("http://127.0.0.1:54421", false), "local");
  assert.equal(environmentOf("http://localhost:54421", false), "local");
  assert.equal(environmentOf("https://abcd.supabase.co", false), "local-hosted");
  assert.equal(environmentOf("https://abcd.supabase.co", true), "production");
  // Unreadable configuration must not make the page claim it is a private sandbox.
  assert.equal(environmentOf("not a url", false), "local-hosted");
});

test("on the hosted database from a laptop, the project exists but bootstrap is judged by links", () => {
  const hosted = states({ ...fresh, environment: "local-hosted" });
  assert.equal(hosted["local-app"], "done");
  assert.equal(hosted["supabase-project"], "done");
  assert.equal(hosted.bootstrap, "todo");
  assert.equal(hosted.release, "manual");
});

test("a fresh clone: local steps done, cloud steps still to do", () => {
  assert.deepEqual(states(fresh), {
    "local-app": "done",
    agent: "done",
    model: "todo",
    "supabase-project": "todo",
    tokens: "manual",
    bootstrap: "todo",
    release: "manual",
    "production-check": "manual",
  });
  assert.equal(countRemaining(buildSteps(fresh)), 3);
});

test("an unreachable agent is a problem and the model step is not guessed", () => {
  const steps = buildSteps({ ...fresh, agent: { reachable: false, reason: "Connection refused." } });
  const agent = steps.find((step) => step.id === "agent");
  assert.equal(agent?.state, "problem");
  assert.equal(agent?.summary, "Connection refused.");
  assert.equal(steps.some((step) => step.id === "model"), false);
});

test("bootstrap is done only when all three links exist, and names what is missing", () => {
  const partly = buildSteps({ ...fresh, supabaseLinked: true, vercelWebLinked: true });
  const bootstrap = partly.find((step) => step.id === "bootstrap");
  assert.equal(bootstrap?.state, "todo");
  assert.equal(bootstrap?.summary, "Not linked yet: the Vercel project for agent/.");
  assert.equal(partly.find((step) => step.id === "supabase-project")?.state, "done");

  const all = states({ ...fresh, supabaseLinked: true, vercelWebLinked: true, vercelAgentLinked: true });
  assert.equal(all.bootstrap, "done");
  assert.equal(all.tokens, "done");
  // A release cannot be seen from a laptop, linked or not.
  assert.equal(all.release, "manual");
});

test("links that could not be observed count as not done, never as done", () => {
  const unknown = states({ ...fresh, supabaseLinked: null, vercelWebLinked: null, vercelAgentLinked: null });
  assert.equal(unknown.bootstrap, "todo");
  assert.equal(unknown["supabase-project"], "todo");
});

test("in production the cloud steps are done by definition and a real model is recognised", () => {
  const production = states({
    environment: "production",
    agent: { reachable: true, model: "anthropic:claude-opus-5-5", version: "abc123" },
    supabaseLinked: null,
    vercelWebLinked: null,
    vercelAgentLinked: null,
  });
  assert.deepEqual(production, {
    agent: "done",
    model: "done",
    "supabase-project": "done",
    tokens: "done",
    bootstrap: "done",
    release: "done",
    "production-check": "manual",
  });
});
