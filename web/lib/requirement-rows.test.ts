import assert from "node:assert/strict";
import { test } from "node:test";

import { countByRegulation, requirementRows } from "./requirement-rows.ts";

test("reads the schema's nested source", () => {
  const output = JSON.stringify({
    team_id: "t",
    case_id: "c",
    requirements: [{ id: "A", text: "Lamp shall be red.", source: { regulation: "UN R7", version: "02", page: 4, paragraph: "5.1" } }],
  });
  assert.deepEqual(requirementRows(output), [
    { id: "A", text: "Lamp shall be red.", regulation: "UN R7", version: "02", page: 4, paragraph: "5.1" },
  ]);
});

test("still shows a flat citation, and leaves a bad page empty", () => {
  const rows = requirementRows(JSON.stringify({ requirements: [{ id: "B", text: "x", regulation: "UN R48", page: "n/a" }] }));
  assert.equal(rows?.[0]?.regulation, "UN R48");
  assert.equal(rows?.[0]?.page, null);
});

test("is null for prose and for a file without requirements", () => {
  assert.equal(requirementRows("not json"), null);
  assert.equal(requirementRows(JSON.stringify({ changes: [] })), null);
});

test("counts per regulation, most first, codes in numeric order on a tie", () => {
  const rows = ["UN R48", "UN R10", "UN R7", "UN R48"].map((regulation) => ({
    id: "",
    text: "",
    regulation,
    version: "",
    page: null,
    paragraph: "",
  }));
  assert.deepEqual(countByRegulation(rows), [
    { regulation: "UN R48", count: 2 },
    { regulation: "UN R7", count: 1 },
    { regulation: "UN R10", count: 1 },
  ]);
});
