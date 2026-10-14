// The web and the shell scripts describe the same things in two languages. These tests read the
// scripts and fail when the two stop agreeing, instead of the setup failing at a real run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LOCAL_DEMO_USER } from "./config.ts";
import { MIN_PASSWORD_LENGTH, needsProviderKey, parseConnectAnswers } from "./connect-answers.ts";
import { LAST_RELEASE_STEP, RELEASE_JOB } from "./releases.ts";

const script = (name: string) => readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
const bootstrap = script("bootstrap.sh");

test("every answer the form sends is one the bootstrap script asks for", () => {
  const asked = new Set(
    [...bootstrap.matchAll(/\b(?:ask(?:_secret)?|given) ([a-z_]+)\b/g)].map((m) => m[1]),
  );
  const parsed = parseConnectAnswers({
    project_ref: "abcdefghijklmnopqrst",
    db_password: "p",
    supabase_token: "t",
    vercel_token: "v",
    agent_model: "anthropic:claude-opus-5-5",
    provider_key: "k",
    name: "my-project",
    agent_domain: "my-project-agent.vercel.app",
    secret_key: "sb_secret_abc",
    releases_token: "github_pat_abc",
    users: [{ email: "a@b.co", password: "twelve chars" }],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const sent = Object.keys({ ...parsed.value, shared_secret: "s" }).filter((key) => key !== "users");
  for (const key of sent) assert.ok(asked.has(key), `bootstrap.sh never asks for "${key}"`);
  // Users are read as a list, not through ask.
  assert.match(bootstrap, /\.get\("users"\)/);
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
  const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /VERCEL_CLI_VERSION:\s*"\d+\.\d+\.\d+"/);
});

// lib/releases.ts tells "released" from "checks passed, nothing deployed" by these names.
test("the release view knows the workflow's job and step names", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  for (const name of [
    RELEASE_JOB,
    LAST_RELEASE_STEP,
    "Is this commit still the head of main",
    "Apply migrations",
    "Deploy agent (not yet live)",
  ]) {
    assert.match(workflow, new RegExp(`name: ${name.replace(/[()]/g, "\\$&")}\n`), `deploy.yml has no "${name}"`);
  }
});
