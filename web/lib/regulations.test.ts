import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_DELETION,
  addOutcome,
  batches,
  confirmsClear,
  countFiles,
  describeConsequences,
  describeCounts,
  describeDeletion,
  parseDeleteRequest,
  parseImportRequest,
  readIndexFile,
  summarizeIndex,
} from "./regulations.ts";

// The shape of the challenge's index, with made-up values.
const ORG = "11111111-1111-4111-8111-111111111111";

const INDEX = [
  {
    regulation: "UN R10",
    versions: [
      { version_label: "7.2.0", role: "base", files: [{ name: "a.pdf" }] },
      { version_label: "7.3.0", role: "latest", files: [{ name: "b.pdf" }] },
    ],
  },
  { regulation: "UN GTR 9", versions: [{ version_label: "2.0.0", role: "base", files: [{ name: "c.pdf" }] }] },
];

test("an index is summarised as regulations and files", () => {
  assert.deepEqual(summarizeIndex(INDEX), { regulations: 2, files: 3, problems: [] });
});

test("something that is not an index says so", () => {
  assert.deepEqual(summarizeIndex({ regulation: "UN R10" }).problems, ["The file is not a list of regulations."]);
  assert.match(summarizeIndex([{ regulation: "UN R10" }]).problems[0], /UN R10 has no versions/);
  assert.match(summarizeIndex([{ versions: [] }]).problems[0], /no "regulation" name/);
});

test("a file that is not JSON gets a sentence, not the parser's message", () => {
  assert.deepEqual(readIndexFile("{nope"), { ok: false, error: "The file is not valid JSON." });
  assert.deepEqual(readIndexFile("[1]"), { ok: true, value: [1] });
  assert.equal(readIndexFile("x".repeat(2_000_001)).ok, false);
});

test("an import request keeps only the file's name", () => {
  const parsed = parseImportRequest({ organization_id: ORG, source_name: "C:\\Users\\me\\index.json", index: INDEX });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.sourceName, "index.json");
  assert.equal(parsed.value.organizationId, ORG);
});

test("an import request without an index is refused", () => {
  assert.equal(parseImportRequest({ organization_id: ORG, source_name: "index.json" }).ok, false);
  assert.equal(parseImportRequest({ organization_id: ORG, source_name: "", index: INDEX }).ok, false);
  assert.equal(parseImportRequest({ organization_id: ORG, source_name: "index.json", index: [] }).ok, false);
  assert.equal(parseImportRequest({ source_name: "index.json", index: INDEX }).ok, false);
});

test("progress reads as a sentence", () => {
  const counts = countFiles(["stored", "stored", "unchanged", "failed", "pending"]);
  assert.equal(describeCounts(counts), "5 files: 2 stored, 1 already in the library, 1 failed, 1 to go");
  assert.equal(describeCounts(countFiles([])), "Reading the file…");
});

// ---------------------------------------------------------------- deleting (SYS-46, #56)

const REG = "22222222-2222-4222-8222-222222222222";

test("a delete names the regulations, or asks for the whole library with the typed name", () => {
  assert.deepEqual(parseDeleteRequest({ organization_id: ORG, regulation_ids: [REG, REG] }), {
    ok: true,
    value: { organizationId: ORG, target: { ids: [REG] } },
  });
  assert.deepEqual(parseDeleteRequest({ organization_id: ORG, all: true, confirm: "Org one" }), {
    ok: true,
    value: { organizationId: ORG, target: { all: true, confirm: "Org one" } },
  });
  assert.equal(parseDeleteRequest({ organization_id: ORG, all: true }).ok, false);
  assert.equal(parseDeleteRequest({ organization_id: ORG, regulation_ids: [] }).ok, false);
  assert.equal(parseDeleteRequest({ organization_id: ORG, regulation_ids: ["UN R10"] }).ok, false);
  // `all` must be the boolean: a stray "true" string from a form is a request for nothing.
  assert.equal(parseDeleteRequest({ organization_id: ORG, all: "true", confirm: "Org one" }).ok, false);
  assert.equal(parseDeleteRequest({ regulation_ids: [REG] }).ok, false);
});

test("clearing needs the organisation's name, not just anything typed", () => {
  assert.equal(confirmsClear(" org one ", "Org one"), true);
  assert.equal(confirmsClear("Org", "Org one"), false);
  assert.equal(confirmsClear("", ""), false);
});

test("a library is deleted in batches the database accepts", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 25), []);
});

test("batches add up to one answer", () => {
  const one = addOutcome(NO_DELETION, { regulations: 2, versions: 3, paragraphs: 900, requirements_unlinked: 0, paths: ["a"] });
  const both = addOutcome(one, { regulations: 1, versions: 1, paragraphs: 1, requirements_unlinked: 4, paths: ["b", 7] });
  assert.deepEqual(both, { regulations: 3, versions: 4, paragraphs: 901, requirementsUnlinked: 4, paths: ["a", "b"] });
  assert.equal(
    describeDeletion(both),
    "Deleted 3 regulations: 4 versions, 901 paragraphs. 4 requirements kept their citation without the link.",
  );
  assert.equal(describeDeletion(NO_DELETION), "Nothing to delete: the library is already empty.");
});

test("the confirmation says what goes and what stays", () => {
  const cited = describeConsequences({ regulations: 1, versions: 2, paragraphs: 1100, requirements: 1 });
  assert.match(cited.removed, /1 regulation, 2 versions and their PDFs, 1,100 paragraphs/);
  assert.match(cited.kept, /1 requirement already written cites it\. It stays with its run/);
  assert.match(cited.kept, /does not restore it/);
  assert.match(describeConsequences({ regulations: 3, versions: 3, paragraphs: 0, requirements: 0 }).kept, /No requirement cites them/);
});
