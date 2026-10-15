import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_PERMISSIONS,
  appManifest,
  appName,
  appSettingsUrl,
  installUrl,
  manifestAction,
  parseCreatedApp,
} from "./github-app.ts";

test("an organisation's app is managed under the organisation's settings", () => {
  assert.equal(appSettingsUrl("User", "me", "a-1"), "https://github.com/settings/apps/a-1");
  assert.equal(appSettingsUrl("Organization", "acme", "a-1"), "https://github.com/organizations/acme/settings/apps/a-1");
});

test("app names fit GitHub's 34 characters and stay unique per clone", () => {
  assert.equal(appName("hackathon-prep", "ab12cd"), "hackathon-prep-ab12cd");
  const long = appName("a-very-long-repository-name-for-the-hackathon", "ab12cd");
  assert.ok(long.length <= 34, long);
  assert.ok(long.endsWith("-ab12cd"));
  assert.ok(!long.includes("--"));
  assert.equal(appName("My_Repo.Name", "XYZ999"), "my-repo-name-xyz999");
});

test("the manifest sends the browser back to this server and asks for no webhooks", () => {
  const manifest = appManifest("me/repo", "http://127.0.0.1:3000", "repo-ab12cd");
  assert.equal(manifest.redirect_url, "http://127.0.0.1:3000/api/setup/github/callback");
  assert.equal(manifest.setup_url, "http://127.0.0.1:3000/api/setup/github/installed");
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_events, []);
});

test("the app cannot touch code or administer the repository", () => {
  const keys = Object.keys(APP_PERMISSIONS);
  for (const forbidden of ["administration", "contents", "workflows", "secrets"]) {
    assert.ok(!keys.includes(forbidden), forbidden);
  }
});

test("personal and organisation repositories post to different places, with the state", () => {
  assert.equal(manifestAction("User", "me", "s1"), "https://github.com/settings/apps/new?state=s1");
  assert.equal(
    manifestAction("Organization", "acme", "s 2"),
    "https://github.com/organizations/acme/settings/apps/new?state=s%202",
  );
});

test("the install page has the account and repository chosen in advance", () => {
  const url = new URL(installUrl("repo-ab12cd", 42, 7, "s1"));
  assert.equal(url.pathname, "/apps/repo-ab12cd/installations/new/permissions");
  assert.equal(url.searchParams.get("suggested_target_id"), "42");
  assert.deepEqual(url.searchParams.getAll("repository_ids[]"), ["7"]);
  assert.equal(url.searchParams.get("state"), "s1");
});

test("only a complete conversion answer is kept, without the secrets nothing uses", () => {
  const app = parseCreatedApp({
    id: 9,
    slug: "repo-ab12cd",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
    client_secret: "unused",
    webhook_secret: "unused",
    owner: { login: "me" },
  });
  assert.deepEqual(Object.keys(app ?? {}).sort(), ["id", "owner", "pem", "slug"]);
  assert.equal(parseCreatedApp({ id: 9, slug: "x" }), null);
  assert.equal(parseCreatedApp({ id: 9, slug: "x", pem: "not a key" }), null);
});
