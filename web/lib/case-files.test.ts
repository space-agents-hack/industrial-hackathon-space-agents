import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACCEPT,
  CASE_FORMATS,
  MAX_FILE_BYTES,
  MAX_FILES,
  TEXT_PREVIEW_CHARS,
  casePath,
  displayType,
  formatOf,
  isSettled,
  refusal,
  storagePath,
  textPreview,
  viewOf,
} from "./case-files.ts";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261024160000_case_files.sql", import.meta.url),
  "utf8",
);
const ingest = readFileSync(new URL("../../agent/agent_service/domain/ingest.py", import.meta.url), "utf8");

test("the web, the database and the agent accept the same formats", () => {
  const check = migration.match(/check \(format in \(([^)]*)\)\)/);
  assert.ok(check, "format check not found in the migration");
  const inDatabase = [...check[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...inDatabase].sort(), [...CASE_FORMATS].sort());
  const literal = ingest.match(/Format = Literal\[([^\]]*)\]/);
  assert.ok(literal, "Format literal not found in ingest.py");
  const inAgent = [...literal[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...inAgent].sort(), [...CASE_FORMATS].sort());
});

test("the limits match the bucket and start_run()", () => {
  assert.match(migration, new RegExp(`false, ${MAX_FILE_BYTES}\\)`));
  assert.match(migration, new RegExp(`jsonb_array_length\\(p_files\\) > ${MAX_FILES}`));
});

test("extensions map to formats, case-insensitively, and CAD is accepted", () => {
  assert.equal(formatOf("Spec.MD"), "md");
  assert.equal(formatOf("view.jpg"), "jpeg");
  assert.equal(formatOf("housing.STP"), "step");
  assert.equal(formatOf("housing.igs"), "iges");
  assert.equal(formatOf("lens.stl"), "stl");
  assert.equal(formatOf("notes.doc"), null);
  assert.equal(formatOf("README"), null);
  assert.ok(ACCEPT.includes(".step") && ACCEPT.includes(".jpg"));
});

test("a file is refused with a reason before anything is uploaded", () => {
  assert.equal(refusal({ name: "spec.md", size: 10 }), null);
  assert.match(refusal({ name: "deck.pptx", size: 10 }) ?? "", /not read yet/);
  assert.match(refusal({ name: "spec.md", size: 0 }) ?? "", /empty/);
  assert.match(refusal({ name: "scan.pdf", size: MAX_FILE_BYTES + 1 }) ?? "", /25 MB/);
});

test("storage paths start with the organisation and keep only safe characters", () => {
  const path = storagePath("org-id", "upload-id", 0, "Spec (v2) ä.pdf");
  assert.equal(path, "org-id/upload-id/1-Spec_v2_a_.pdf");
  assert.equal(storagePath("o", "u", 1, "...hidden"), "o/u/2-hidden");
});

test("a case file sits in the case's folder, where the insert policy looks for it", () => {
  const path = casePath("org", "case-id", 2, "exploded view.png");
  assert.equal(path.split("/")[1], "case-id");
  assert.equal(path, "org/case-id/3-exploded_view.png");
});

test("only parsed and failed files are settled", () => {
  assert.deepEqual(
    ["pending", "parsing", "parsed", "failed"].map(isSettled),
    [false, false, true, true],
  );
});

test("every accepted format has a way to be viewed", () => {
  for (const format of CASE_FORMATS) assert.ok(viewOf(format, "x"), format);
  assert.equal(viewOf("md", "spec.md"), "markdown");
  assert.equal(viewOf("jpeg", "photo.JPG"), "image");
  assert.equal(viewOf("stl", "part.stl"), "download");
  // A row without a known format falls back to the name, then to the download.
  assert.equal(viewOf(null, "notes.markdown"), "markdown");
  assert.equal(viewOf(null, "mystery.bin"), "download");
});

test("images and PDFs are shown with their own media type, not the stored octet-stream", () => {
  assert.equal(displayType("pdf", "pdf", "a.pdf"), "application/pdf");
  assert.equal(displayType("image", "jpeg", "a.jpg"), "image/jpeg");
  assert.equal(displayType("image", null, "a.webp"), "image/webp");
});

test("JSON is indented, broken JSON is shown raw, and long text is cut", () => {
  assert.equal(textPreview("json", '{"a":1}').text, '{\n  "a": 1\n}');
  assert.equal(textPreview("json", "{broken").text, "{broken");
  const long = textPreview("text", "x".repeat(TEXT_PREVIEW_CHARS + 1));
  assert.equal(long.cut, true);
  assert.equal(long.text.length, TEXT_PREVIEW_CHARS);
});
