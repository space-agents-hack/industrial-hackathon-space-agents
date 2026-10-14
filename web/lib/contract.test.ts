// The web and the shell scripts describe the same things in two languages. These tests read the
// scripts and fail when the two stop agreeing, instead of the setup failing at a real run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LOCAL_DEMO_USER } from "./config.ts";
import { MIN_PASSWORD_LENGTH } from "./admin.ts";
import { BOOTSTRAP_SECRETS, needsProviderKey } from "./deployment.ts";
import { parseProductionAnswers } from "./production-answers.ts";
import { LAST_RELEASE_STEP, RELEASE_JOB } from "./releases.ts";

const script = (name: string) => readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
const bootstrap = script("bootstrap.sh");

const workflow = (name: string) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const bootstrapWorkflow = workflow("bootstrap.yml");
const deployWorkflow = workflow("deploy.yml");

test("every answer the Bootstrap workflow sends is one the script asks for", () => {
  const asked = new Set(
    [...bootstrap.matchAll(/\b(?:ask(?:_secret)?|given) ([a-z_]+)\b/g)].map((m) => m[1]),
  );
  const sent = [...bootstrapWorkflow.matchAll(/^\s+"([a-z_]+)": /gm)].map((m) => m[1]).filter((key) => key !== "users");
  assert.ok(sent.length >= 8, "could not find the answers in bootstrap.yml");
  for (const key of sent) assert.ok(asked.has(key), `bootstrap.sh never asks for "${key}"`);
  // Users are read as a list, not through ask.
  assert.match(bootstrap, /\.get\("users"\)/);
});

test("every answer the Setup page's form sends is one the script asks for", () => {
  const asked = new Set([...bootstrap.matchAll(/\b(?:ask(?:_secret)?|given) ([a-z_]+)\b/g)].map((m) => m[1]));
  for (const extra of [
    { supabase_org: "org", region: "eu-west-1" },
    { project_ref: "abcdefghijklmnopqrst", db_password: "pw" },
  ]) {
    const parsed = parseProductionAnswers({
      vercel_token: "vercel_abcdefgh",
      supabase_token: "sbp_abcdefgh",
      github_token: "github_pat_abc",
      vercel_team: "team",
      name: "my-project",
      agent_model: "anthropic:claude-opus-5-5",
      provider_key: "k",
      email: "a@b.co",
      password: "twelve chars",
      ...extra,
    });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    for (const key of Object.keys(parsed.value).filter((k) => k !== "users")) {
      assert.ok(asked.has(key), `bootstrap.sh never asks for "${key}"`);
    }
  }
});

test("the Bootstrap workflow checks for the secrets the setup steps list", () => {
  const check = /for name in ([A-Z_ ]+); do/.exec(bootstrapWorkflow)?.[1].trim().split(" ") ?? [];
  assert.deepEqual([...check].sort(), [...BOOTSTRAP_SECRETS].sort());
});

test("both workflows use the same Supabase CLI", () => {
  const pinned = /SUPABASE_CLI_VERSION:\s*"([^"]+)"/.exec(deployWorkflow)?.[1];
  assert.ok(pinned);
  assert.match(bootstrapWorkflow, new RegExp(`version: "${pinned.replaceAll(".", "\\.")}"`));
});

test("both sides agree on which models need a provider key", () => {
  const prefixes = [...bootstrap.matchAll(/^\s+([a-z|:*-]+)\) provider_key_name="/gm)]
    .flatMap((m) => m[1].split("|"))
    .map((p) => p.replace("*", "x"));
  assert.ok(prefixes.length >= 4);
  for (const model of prefixes) assert.ok(needsProviderKey(model), `${model} not known to the form`);
  assert.equal(needsProviderKey("scripted"), false);
});

test("the minimum password length and the local demo user are the same everywhere", () => {
  const createUser = script("create-user.sh");
  assert.match(createUser, new RegExp(`-lt ${MIN_PASSWORD_LENGTH}\\b`));
  assert.match(createUser, new RegExp(`LOCAL_EMAIL="${LOCAL_DEMO_USER.email}"`));
  assert.match(createUser, new RegExp(`LOCAL_PASSWORD="${LOCAL_DEMO_USER.password}"`));
});

test("the setup page reads the Vercel CLI version CI pins", () => {
  assert.match(deployWorkflow, /VERCEL_CLI_VERSION:\s*"\d+\.\d+\.\d+"/);
});

// lib/releases.ts tells "released" from "checks passed, nothing deployed" by these names.
test("the release view knows the workflow's job and step names", () => {
  for (const name of [
    RELEASE_JOB,
    LAST_RELEASE_STEP,
    "Is this commit still the head of main",
    "Apply migrations",
    "Deploy agent (not yet live)",
  ]) {
    assert.match(deployWorkflow, new RegExp(`name: ${name.replace(/[()]/g, "\\$&")}\n`), `deploy.yml has no "${name}"`);
  }
});
