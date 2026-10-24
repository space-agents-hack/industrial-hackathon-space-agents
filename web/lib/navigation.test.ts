import assert from "node:assert/strict";
import { test } from "node:test";

import { SETTINGS_TAB, needsProject, projectTabs, settingsTabs } from "./navigation.ts";

test("runs, regulations, changes and checks need a project", () => {
  for (const path of ["/runs", "/regulations", "/regulations/abc", "/changes", "/checks"]) {
    assert.equal(needsProject(path), true, path);
  }
});

test("a run's own page opens without a project, so a shared link always works", () => {
  assert.equal(needsProject("/runs/5b0e6f1e-0000-0000-0000-000000000000"), false);
});

test("the picker, onboarding, settings and the project's own pages need no project picked", () => {
  for (const path of ["/", "/projects", "/projects/x", "/welcome", "/admin", "/admin/setup", "/setup", "/login"]) {
    assert.equal(needsProject(path), false, path);
  }
  // A prefix is not a section: /runsheet is not /runs.
  assert.equal(needsProject("/runsheet"), false);
});

test("the project's tabs mark the one open, and Cases covers a case page", () => {
  const tabs = projectTabs("p1");
  assert.deepEqual(
    tabs.map((t) => t.label),
    ["Parts", "Regulations", "Draft requirements", "Review requirements", "Checks"],
  );
  const cases = tabs.find((t) => t.label === "Parts")!;
  assert.equal(cases.href, "/projects/p1");
  assert.equal(cases.matches("/projects/p1/cases/c1"), true);
  assert.equal(cases.matches("/projects/p2"), false);
  assert.equal(tabs.find((t) => t.label === "Draft requirements")!.matches("/runs/r1"), true);
});

test("Settings holds the former Admin and Setup", () => {
  assert.equal(SETTINGS_TAB.matches("/admin/people"), true);
  assert.equal(SETTINGS_TAB.matches("/setup"), true);
  assert.equal(SETTINGS_TAB.matches("/projects"), false);
});

test("an organisation admin gets the organisation's tabs only; the deployment's are platform admins'", () => {
  const deployment = ["Organisations", "Setup", "Releases", "Deployment"];
  const orgAdmin = settingsTabs(false).map((t) => t.label);
  assert.ok(orgAdmin.includes("People"));
  for (const label of deployment) assert.equal(orgAdmin.includes(label), false, label);
  const platform = settingsTabs(true).map((t) => t.label);
  for (const label of deployment) assert.equal(platform.includes(label), true, label);
});
