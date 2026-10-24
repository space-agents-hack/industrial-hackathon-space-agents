import assert from "node:assert/strict";
import { test } from "node:test";

import { describeParser, nameTakenMessage } from "./cases.ts";

test("a block says whether a parser or a model produced it", () => {
  // A model can reword what it read; the case page has to say which blocks came from one (SYS-27).
  assert.equal(describeParser("pypdf"), "read by pypdf");
  assert.equal(describeParser("model:anthropic:claude-haiku-5-5"), "described by a model (anthropic:claude-haiku-5-5)");
});

test("only a duplicate name gets the duplicate message", () => {
  assert.equal(nameTakenMessage("23505", "case", "Housing"), 'A case called "Housing" already exists here.');
  assert.equal(nameTakenMessage("42501", "case", "Housing"), null);
});
