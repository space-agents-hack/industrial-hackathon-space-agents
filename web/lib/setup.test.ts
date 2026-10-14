import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SetupFacts,
  type StepId,
  type StepState,
  type Target,
  type Via,
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

function states(target: Target, facts: SetupFacts, via: Via = "form"): Partial<Record<StepId, StepState>> {
  return Object.fromEntries(buildSteps(target, facts, via).map((step) => [step.id, step.state]));
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

test("a fresh clone with gh signed in: tokens, one form, then the release", () => {
  assert.deepEqual(states("production", fresh), {
    tokens: "manual",
    create: "todo",
    push: "manual",
    "try-production": "manual",
    manage: "manual",
  });
  const done = states("production", { ...fresh, productionSecrets: ["VERCEL_TOKEN", "VERCEL_WEB_PROJECT_ID"] });
  assert.equal(done.create, "done");
  assert.equal(done.tokens, "done");
  // A release cannot be judged from the secret names.
  assert.equal(done.push, "manual");
});

test("without gh, the form cannot write to GitHub: say so first", () => {
  const steps = buildSteps("production", { ...fresh, repo: null, productionSecrets: null });
  assert.equal(steps[0].id, "gh");
  assert.equal(steps[0].state, "todo");
});

test("the GitHub path follows the secret names GitHub holds", () => {
  const empty = buildSteps("production", fresh, "github");
  assert.deepEqual(
    empty.map((step) => [step.id, step.state]),
    [["tokens", "manual"], ["secrets", "todo"], ["bootstrap", "todo"], ["push", "manual"], ["try-production", "manual"], ["manage", "manual"]],
  );
  assert.match(empty[1].summary, /VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN, GH_CONTROL_TOKEN/);

  const pasted = states(
    "production",
    { ...fresh, productionSecrets: ["VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "GH_CONTROL_TOKEN"] },
    "github",
  );
  assert.equal(pasted.secrets, "done");
  assert.equal(pasted.bootstrap, "todo");
});

test("when GitHub could not be asked, the GitHub path claims nothing either way", () => {
  const unknown = states("production", { ...fresh, productionSecrets: null }, "github");
  assert.equal(unknown.secrets, "manual");
  assert.equal(unknown.bootstrap, "manual");
});

test("a laptop on the hosted database: the page says who sees its runs", () => {
  assert.match(describeWhere({ ...fresh, database: "hosted" }), /visible to everyone/);
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
    tokens: "done",
    create: "done",
    push: "done",
    "try-production": "manual",
    manage: "manual",
    model: "done",
  });
  const broken = buildSteps("production", { ...live, agent: down });
  assert.equal(broken[0].id, "dev");
  assert.equal(broken[0].state, "problem");
});
