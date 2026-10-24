import assert from "node:assert/strict";
import { test } from "node:test";

import {
  citedRegulation,
  defaultPair,
  parseChangesRequest,
  parseChangesResult,
  parseSubgoalCases,
  readRequirementsFile,
} from "./changes.ts";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const BODY = { organization_id: ORG, old_version_id: OLD, new_version_id: NEW, case_id: "subgoal-dev", team_id: "team-07" };

test("parseChangesRequest takes a loaded case or an uploaded list", () => {
  const loaded = parseChangesRequest(BODY);
  assert.ok(loaded.ok);
  assert.equal(loaded.value.requirementsOld, null);

  const uploaded = parseChangesRequest({ ...BODY, requirements_old: [{ id: "A-1", text: "The lamp shall be red." }] });
  assert.ok(uploaded.ok);
  assert.equal(uploaded.value.requirementsOld?.length, 1);
});

test("parseChangesRequest refuses what the agent would refuse", () => {
  assert.equal(parseChangesRequest({ ...BODY, new_version_id: OLD }).ok, false);
  assert.equal(parseChangesRequest({ ...BODY, team_id: "" }).ok, false);
  assert.equal(parseChangesRequest({ ...BODY, case_id: "../x" }).ok, false);
  assert.equal(parseChangesRequest({ ...BODY, requirements_old: [{ id: "A-1" }] }).ok, false);
  assert.equal(parseChangesRequest({ ...BODY, requirements_old: [] }).ok, false);
});

test("readRequirementsFile says what is wrong in a sentence", () => {
  assert.deepEqual(readRequirementsFile("{"), { ok: false, error: "The file is not valid JSON." });
  const twice = readRequirementsFile(JSON.stringify([{ id: "A", text: "x" }, { id: "A", text: "y" }]));
  assert.deepEqual(twice, { ok: false, error: "The id A appears twice." });
});

test("parseChangesResult reads the agent's answer", () => {
  const result = parseChangesResult({
    submission: {
      team_id: "team-07",
      case_id: "subgoal-dev",
      changes: [
        { requirement_id: "R-2", change: "modified", new_text: "…", reason: "Paragraph 5.2 …", source: { page: 5, paragraph: "5.2" } },
        { requirement_id: "R-3", change: "removed", reason: "… no longer appears." },
      ],
    },
    counts: { modified: 1, removed: 1, added: 0 },
    requirements: 3,
    regulation: "UN R900",
    old_version: "1.0.0",
    new_version: "2.0.0",
  });
  assert.ok(result);
  assert.deepEqual(result.counts, { modified: 1, removed: 1, added: 0 });
  assert.equal(result.changes[0].page, 5);
  assert.equal(result.changes[1].newText, null);
  assert.equal(parseChangesResult({ detail: "Not found" }), null);
});

test("defaultPair compares base with latest, else the two newest", () => {
  const roles = [
    { id: "a", label: "1.0.0", role: null },
    { id: "b", label: "1.1.0", role: "base" },
    { id: "c", label: "2.0.0", role: "latest" },
  ];
  assert.deepEqual(defaultPair(roles), ["b", "c"]);
  const plain = [
    { id: "a", label: "10.0.0", role: null },
    { id: "b", label: "9.0.0", role: null },
    { id: "c", label: "2.0.0", role: null },
  ];
  assert.deepEqual(defaultPair(plain), ["b", "a"]);
  assert.equal(defaultPair([{ id: "a", label: "1", role: null }]), null);
});

test("the regulation to preselect comes from what the requirements cite", () => {
  assert.deepEqual(parseSubgoalCases({ cases: [{ case_id: "subgoal-dev", regulation: "UN R900" }, { x: 1 }] }), [
    { caseId: "subgoal-dev", regulation: "UN R900" },
  ]);
  const reqs = [
    { id: "1", text: "", source: { regulation: "UN R900" } },
    { id: "2", text: "", source: { regulation: "UN R901" } },
    { id: "3", text: "", source: { regulation: "UN R900" } },
  ];
  assert.equal(citedRegulation(reqs), "UN R900");
  assert.equal(citedRegulation([{ id: "1", text: "" }]), null);
});
