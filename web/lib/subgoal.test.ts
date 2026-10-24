import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type EntryLike,
  caseKind,
  filesInEntries,
  isAnswerKey,
  isHiddenPath,
  ofKind,
  screenSubgoalFiles,
  subgoalRefusal,
} from "./subgoal.ts";

test("only 'subgoal' is a sub-goal case; anything else is the main goal's", () => {
  assert.equal(caseKind("subgoal"), "subgoal");
  assert.equal(caseKind("main"), "main");
  assert.equal(caseKind(undefined), "main");
  assert.equal(caseKind("Subgoal"), "main");
});

test("the main goal's lists and Changes each keep their own cases", () => {
  const cases = [
    { id: "a", kind: "main" },
    { id: "b", kind: "subgoal" },
    { id: "c", kind: "main" },
  ];
  assert.deepEqual(
    ofKind(cases, "main").map((c) => c.id),
    ["a", "c"],
  );
  assert.deepEqual(
    ofKind(cases, "subgoal").map((c) => c.id),
    ["b"],
  );
});

test("an object with a changes list is the answer key, whatever the file is called", () => {
  assert.equal(isAnswerKey(JSON.stringify({ team_id: "t", case_id: "c", changes: [] })), true);
  // The inputs are lists.
  assert.equal(isAnswerKey(JSON.stringify([{ id: "x", text: "y", source: {} }])), false);
  assert.equal(isAnswerKey(JSON.stringify([{ name: "old.pdf", pdf_url: "https://example.test/a.pdf" }])), false);
  // A main-goal file, a changes field that is not a list, and text that is not JSON.
  assert.equal(isAnswerKey(JSON.stringify({ requirements: [] })), false);
  assert.equal(isAnswerKey(JSON.stringify({ changes: "none" })), false);
  assert.equal(isAnswerKey("not json"), false);
});

test("a sub-goal case takes .json and .pdf, and still the size limits", () => {
  assert.equal(subgoalRefusal({ name: "requirements_old.json", size: 10 }), null);
  assert.equal(subgoalRefusal({ name: "new.PDF", size: 10 }), null);
  assert.match(subgoalRefusal({ name: "notes.md", size: 10 }) ?? "", /only \.json and \.pdf/);
  assert.match(subgoalRefusal({ name: "old.pdf", size: 0 }) ?? "", /empty/);
});

test("hidden files and folders are recognised at any depth", () => {
  assert.equal(isHiddenPath(".DS_Store"), true);
  assert.equal(isHiddenPath("dev/._old.pdf"), true);
  assert.equal(isHiddenPath("dev/.git/config"), true);
  assert.equal(isHiddenPath("dev/old.pdf"), false);
});

function file(name: string, content: string, webkitRelativePath = "") {
  return { name, size: content.length, webkitRelativePath, text: async () => content };
}

test("screening keeps the inputs, holds back the answer key and refuses other formats", async () => {
  const screened = await screenSubgoalFiles([
    file("requirements_old.json", "[]", "dev/requirements_old.json"),
    file("files.json", "[]", "dev/files.json"),
    file("expected.json", JSON.stringify({ changes: [] }), "dev/expected.json"),
    file("readme.txt", "hello"),
    file(".DS_Store", "x", "dev/.DS_Store"),
  ]);
  assert.deepEqual(
    screened.keep.map((f) => f.name),
    ["requirements_old.json", "files.json"],
  );
  assert.equal(screened.answerKeys.length, 1);
  assert.match(screened.answerKeys[0], /^expected\.json is Certivity's answer key\./);
  assert.equal(screened.problems.length, 1);
  assert.match(screened.problems[0], /^readme\.txt:/);
});

// A fake FileSystemEntry tree. The directory reader hands its entries over in batches of two and
// then an empty batch, as browsers do with larger folders.
function fileEntry(name: string): EntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (success) => success(new File(["x"], name)),
  };
}

function dirEntry(name: string, children: EntryLike[]): EntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (success) => {
          const batch = children.slice(offset, offset + 2);
          offset += batch.length;
          success(batch);
        },
      };
    },
  };
}

test("a dropped folder is walked to the bottom, every batch read, hidden entries left out", async () => {
  const dropped = [
    dirEntry("dev", [
      fileEntry("requirements_old.json"),
      fileEntry("files.json"),
      fileEntry("old.pdf"),
      fileEntry(".DS_Store"),
      dirEntry("nested", [fileEntry("new.pdf")]),
      dirEntry(".git", [fileEntry("config")]),
    ]),
    fileEntry("loose.json"),
  ];
  const names = (await filesInEntries(dropped)).map((f) => f.name);
  assert.deepEqual(names, ["requirements_old.json", "files.json", "old.pdf", "new.pdf", "loose.json"]);
});

test("a file the browser cannot read fails the walk instead of vanishing", async () => {
  const broken: EntryLike = {
    isFile: true,
    isDirectory: false,
    name: "old.pdf",
    file: (_success, failure) => failure?.(new Error("NotReadableError")),
  };
  await assert.rejects(filesInEntries([broken]), /NotReadableError/);
});
