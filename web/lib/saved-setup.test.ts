import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_SETUP, type SavedSetup, parseSetup, serializeSetup } from "./saved-setup.ts";

const full: SavedSetup = {
  project_ref: "abcdefghijklmnopqrst",
  db_password: 'with spaces, "quotes", # and = signs',
  supabase_token: "sbp_0123456789abcdef",
  vercel_token: "vercel_token_value",
  agent_model: "anthropic:claude-opus-5-5",
  provider_key: "sk-ant-123",
  releases_token: "github_pat_x",
  shared_secret: "0123abcd",
  users: [
    { email: "ana@example.com", password: "a password with spaces" },
    { email: "ramon@example.com", password: "tab\tand=equals" },
  ],
};

test("every value survives a round trip, whatever characters it has", () => {
  assert.deepEqual(parseSetup(serializeSetup(full)), full);
});

test("simple values are written unquoted, so the file reads like any env file", () => {
  const text = serializeSetup(full);
  assert.match(text, /^SUPABASE_PROJECT_REF=abcdefghijklmnopqrst$/m);
  assert.match(text, /^AGENT_MODEL=anthropic:claude-opus-5-5$/m);
  assert.match(text, /^USER_1_EMAIL=ana@example.com$/m);
  assert.match(text, /^SUPABASE_DB_PASSWORD=".*"$/m);
});

test("a missing or damaged file gives empty fields, never an error", () => {
  assert.deepEqual(parseSetup(""), EMPTY_SETUP);
  assert.deepEqual(parseSetup("garbage\nSUPABASE_DB_PASSWORD=\"unterminated\n").db_password, "");
  assert.equal(parseSetup("AGENT_MODEL=\n").agent_model, "scripted");
});
