import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProductionAnswers } from "./production-answers.ts";

const valid = {
  vercel_token: "vercel_abcdefgh1234",
  supabase_token: "sbp_0123456789abcdef",
  supabase_org: "my-org",
  email: "Me@Example.test",
  password: "twelve chars!",
};

test("a new project needs an organisation; Frankfurt is the default region", () => {
  const parsed = parseProductionAnswers(valid);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.supabase_org, "my-org");
  assert.equal(parsed.value.region, "eu-central-1");
  assert.equal(parsed.value.project_ref, undefined);
  assert.deepEqual(parsed.value.users, [{ email: "me@example.test", password: "twelve chars!" }]);
  assert.equal(parsed.value.release, "y");

  assert.equal(parseProductionAnswers({ ...valid, supabase_org: "" }).ok, false);
});

test("an existing project ignores the organisation and keeps an optional password exactly", () => {
  const parsed = parseProductionAnswers({ ...valid, project_ref: "abcdefghijklmnopqrst", db_password: " spaced pw " });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.supabase_org, undefined);
  assert.equal(parsed.value.db_password, " spaced pw ");
  assert.equal(parseProductionAnswers({ ...valid, project_ref: "short" }).ok, false);
});

test("tokens are checked for shape before anything runs", () => {
  assert.equal(parseProductionAnswers({ ...valid, supabase_token: "not-a-supabase-token" }).ok, false);
  assert.equal(parseProductionAnswers({ ...valid, vercel_token: "has space in it" }).ok, false);
});

test("the first admin needs a real email and a long enough password", () => {
  assert.equal(parseProductionAnswers({ ...valid, email: "nope" }).ok, false);
  assert.equal(parseProductionAnswers({ ...valid, password: "short" }).ok, false);
});

test("an empty model keeps production's; a written one must look like a model", () => {
  const kept = parseProductionAnswers(valid);
  assert.ok(kept.ok && kept.value.agent_model === undefined);
  assert.equal(parseProductionAnswers({ ...valid, agent_model: "not a model" }).ok, false);
  assert.ok(parseProductionAnswers({ ...valid, agent_model: "anthropic:claude-opus-5-5" }).ok);
});

test("replacing the database has to be asked for", () => {
  const plain = parseProductionAnswers(valid);
  assert.ok(plain.ok && plain.value.replace_database === undefined);
  const asked = parseProductionAnswers({ ...valid, replace_database: true });
  assert.ok(asked.ok && asked.value.replace_database === "y");
});
