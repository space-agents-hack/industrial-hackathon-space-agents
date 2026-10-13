import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SetupFacts,
  type StepId,
  type StepState,
  type Target,
  buildSteps,
  databaseOf,
  describeWhere,
  parseTarget,
} from "./setup.ts";

const down = { reachable: false, reason: "The agent service did not answer." } as const;
const up = { reachable: true, model: "scripted", version: "unknown" } as const;

// A clone on which nothing has been run yet: how most people first see this page.
const fresh: SetupFacts = {
  onVercel: false,
  database: "none",
  agent: down,
  supabaseLinked: false,
  vercelWebLinked: false,
  vercelAgentLinked: false,
};

function states(target: Target, facts: SetupFacts): Partial<Record<StepId, StepState>> {
  return Object.fromEntries(buildSteps(target, facts).map((step) => [step.id, step.state]));
}

test("databaseOf: none without configuration, local for a loopback address, hosted otherwise", () => {
  assert.equal(databaseOf(undefined), "none");
  assert.equal(databaseOf(""), "none");
  assert.equal(databaseOf("http://127.0.0.1:54421"), "local");
  assert.equal(databaseOf("http://localhost:54421"), "local");
  assert.equal(databaseOf("https://abcd.supabase.co"), "hosted");
  // Unreadable configuration must not make the page claim it is a private sandbox.
  assert.equal(databaseOf("not a url"), "hosted");
});

test("parseTarget: anything that is not production is local", () => {
  assert.equal(parseTarget("production"), "production");
  assert.equal(parseTarget("local"), "local");
  assert.equal(parseTarget(undefined), "local");
  assert.equal(parseTarget(["production"]), "local");
});

test("a fresh clone, local target: everything is still to do and nothing is called a problem", () => {
  assert.deepEqual(states("local", fresh), {
    tools: "manual",
    setup: "todo",
    dev: "todo",
    "try-local": "manual",
  });
  assert.match(describeWhere(fresh), /Nothing is set up/);
});

test("after setup, a silent agent is a problem; a running one adds the model step", () => {
  assert.equal(states("local", { ...fresh, database: "local" }).dev, "problem");
  assert.deepEqual(states("local", { ...fresh, database: "local", agent: up }), {
    tools: "done",
    setup: "done",
    dev: "done",
    "try-local": "manual",
    model: "manual",
  });
});

test("a fresh clone, production target: the steps do not depend on anything being installed", () => {
  assert.deepEqual(states("production", fresh), {
    "supabase-project": "todo",
    tokens: "manual",
    bootstrap: "todo",
    push: "manual",
    "try-production": "manual",
  });
});

test("bootstrap is done only when all three links exist, and names what is missing", () => {
  const partly = buildSteps("production", { ...fresh, supabaseLinked: true, vercelWebLinked: true });
  const bootstrap = partly.find((step) => step.id === "bootstrap");
  assert.equal(bootstrap?.state, "todo");
  assert.equal(bootstrap?.summary, "Not linked yet: the Vercel project for agent/.");
  assert.equal(partly.find((step) => step.id === "supabase-project")?.state, "done");

  const all = states("production", {
    ...fresh,
    supabaseLinked: true,
    vercelWebLinked: true,
    vercelAgentLinked: true,
  });
  assert.equal(all.bootstrap, "done");
  assert.equal(all.tokens, "done");
  // A release cannot be seen from a laptop, linked or not.
  assert.equal(all.push, "manual");
});

test("links that could not be observed count as not done, never as done", () => {
  const unknown = states("production", {
    ...fresh,
    supabaseLinked: null,
    vercelWebLinked: null,
    vercelAgentLinked: null,
  });
  assert.equal(unknown.bootstrap, "todo");
  assert.equal(unknown["supabase-project"], "todo");
});

test("a laptop on the hosted database: the project exists, and the page says who sees its runs", () => {
  const hosted = { ...fresh, database: "hosted" as const };
  assert.equal(states("production", hosted)["supabase-project"], "done");
  assert.match(describeWhere(hosted), /visible to everyone/);
});

test("deployed: production steps are done by definition and a dead agent goes to the top", () => {
  const live: SetupFacts = {
    onVercel: true,
    database: "hosted",
    agent: { reachable: true, model: "anthropic:claude-opus-5-5", version: "abc123" },
    supabaseLinked: null,
    vercelWebLinked: null,
    vercelAgentLinked: null,
  };
  assert.deepEqual(states("production", live), {
    "supabase-project": "done",
    tokens: "done",
    bootstrap: "done",
    push: "done",
    "try-production": "manual",
    model: "done",
  });
  const broken = buildSteps("production", { ...live, agent: down });
  assert.equal(broken[0].id, "dev");
  assert.equal(broken[0].state, "problem");
});
