import assert from "node:assert/strict";
import { test } from "node:test";

import { SETTINGS_TAB, needsProject, projectTabs } from "./navigation.ts";

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
    ["Cases", "Runs", "Regulations", "Changes", "Checks"],
  );
  const cases = tabs.find((t) => t.label === "Cases")!;
  assert.equal(cases.href, "/projects/p1");
  assert.equal(cases.matches("/projects/p1/cases/c1"), true);
  assert.equal(cases.matches("/projects/p2"), false);
  assert.equal(tabs.find((t) => t.label === "Runs")!.matches("/runs/r1"), true);
});

test("Settings holds the former Admin and Setup", () => {
  assert.equal(SETTINGS_TAB.matches("/admin/people"), true);
  assert.equal(SETTINGS_TAB.matches("/setup"), true);
  assert.equal(SETTINGS_TAB.matches("/projects"), false);
});
