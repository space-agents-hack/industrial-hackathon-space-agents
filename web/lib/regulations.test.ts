import assert from "node:assert/strict";
import { test } from "node:test";

import { countFiles, describeCounts, parseImportRequest, readIndexFile, summarizeIndex } from "./regulations.ts";

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
