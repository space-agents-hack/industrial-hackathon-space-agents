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
  repo: "o/r",
  productionSecrets: [],
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
    customise: "manual",
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
    customise: "manual",
  });
});

test("a fresh clone, production target: GitHub has nothing yet", () => {
  assert.deepEqual(states("production", fresh), {
    "supabase-project": "todo",
    tokens: "manual",
    secrets: "todo",
    bootstrap: "todo",
    push: "manual",
    "try-production": "manual",
    manage: "manual",
  });
  const secrets = buildSteps("production", fresh).find((step) => step.id === "secrets");
  assert.match(secrets?.summary ?? "", /VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, GH_CONTROL_TOKEN/);
});

test("the steps follow the secret names GitHub holds", () => {
  const pasted = states("production", {
    ...fresh,
    productionSecrets: ["VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "GH_CONTROL_TOKEN"],
  });
  assert.equal(pasted["supabase-project"], "done");
  assert.equal(pasted.tokens, "done");
  assert.equal(pasted.secrets, "done");
  assert.equal(pasted.bootstrap, "todo");

  const ran = states("production", {
    ...fresh,
    productionSecrets: ["VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "GH_CONTROL_TOKEN", "VERCEL_WEB_PROJECT_ID"],
  });
  assert.equal(ran.bootstrap, "done");
  // A release cannot be judged from the secret names.
  assert.equal(ran.push, "manual");
});

test("when GitHub could not be asked, nothing is claimed either way", () => {
  const unknown = states("production", { ...fresh, productionSecrets: null });
  assert.equal(unknown.secrets, "manual");
  assert.equal(unknown.bootstrap, "manual");
  assert.equal(unknown["supabase-project"], "manual");
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
    repo: null,
    productionSecrets: null,
  };
  assert.deepEqual(states("production", live), {
    "supabase-project": "done",
    tokens: "done",
    secrets: "done",
    bootstrap: "done",
    push: "done",
    "try-production": "manual",
    manage: "manual",
    model: "done",
  });
  const broken = buildSteps("production", { ...live, agent: down });
  assert.equal(broken[0].id, "dev");
  assert.equal(broken[0].state, "problem");
});
