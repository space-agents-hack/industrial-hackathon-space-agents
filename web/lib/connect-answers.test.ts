import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConnectAnswers } from "./connect-answers.ts";

const valid = {
  project_ref: "abcdefghijklmnopqrst",
  db_password: "a generated password",
  supabase_token: "sbp_x",
  vercel_token: "vt_x",
  apply_migrations: true,
  agent_model: "scripted",
  users: [{ email: "Ana@Example.com", password: "twelve chars" }, { email: "", password: "" }],
};

test("a complete form becomes the JSON the bootstrap script reads", () => {
  const parsed = parseConnectAnswers(valid);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    vercel_token: "vt_x",
    project_ref: "abcdefghijklmnopqrst",
    db_password: "a generated password",
    supabase_token: "sbp_x",
    apply_migrations: "y",
    agent_model: "scripted",
    // Empty rows are dropped; emails are lower-cased.
    users: [{ email: "ana@example.com", password: "twelve chars" }],
  });
});

test("the database password is passed exactly as typed, spaces included", () => {
  const parsed = parseConnectAnswers({ ...valid, db_password: "  spaced  " });
  assert.equal(parsed.ok && parsed.value.db_password, "  spaced  ");
});

test("each missing or malformed field is named", () => {
  const error = (patch: object) => {
    const parsed = parseConnectAnswers({ ...valid, ...patch });
    return parsed.ok ? null : parsed.error;
  };
  assert.match(error({ project_ref: "https://abc.supabase.co" }) ?? "", /Project ID/);
  assert.match(error({ db_password: "" }) ?? "", /database password/);
  assert.match(error({ supabase_token: "  " }) ?? "", /Supabase access token/);
  assert.match(error({ vercel_token: undefined }) ?? "", /Vercel token/);
  assert.match(error({ agent_model: "anthropic:claude-opus-5-5" }) ?? "", /API key/);
  assert.match(error({ users: [{ email: "nope", password: "twelve chars" }] }) ?? "", /email/);
  assert.match(error({ users: [{ email: "a@b.co", password: "short" }] }) ?? "", /12 characters/);
  assert.match(error({ users: [{ email: "a@b.co", password: "has a\nnewline!" }] }) ?? "", /one line/);
  assert.match(error({ name: "Bad Name; rm -rf" }) ?? "", /lowercase/);
  assert.equal(parseConnectAnswers(null).ok, false);
  assert.equal(parseConnectAnswers([]).ok, false);
});

test("migrations are applied unless explicitly turned off; a real model carries its key", () => {
  const off = parseConnectAnswers({ ...valid, apply_migrations: false });
  assert.equal(off.ok && off.value.apply_migrations, "n");
  const real = parseConnectAnswers({ ...valid, agent_model: "openai:gpt-5.2", provider_key: "sk-1" });
  assert.equal(real.ok && real.value.provider_key, "sk-1");
});
