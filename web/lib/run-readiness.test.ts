import assert from "node:assert/strict";
import { test } from "node:test";

import { runBlockers } from "./run-readiness.ts";

test("a case with files in a project with regulations may run", () => {
  assert.deepEqual(runBlockers({ files: 2, library: 10, allRegulations: true, chosen: 0 }), []);
  assert.deepEqual(runBlockers({ files: 1, library: 10, allRegulations: false, chosen: 1 }), []);
});

test("no file, empty library or no chosen regulation each stop the run, with the reason", () => {
  assert.equal(runBlockers({ files: 0, library: 10, allRegulations: true, chosen: 0 }).length, 1);
  assert.match(runBlockers({ files: 1, library: 0, allRegulations: true, chosen: 0 })[0], /library is empty/);
  assert.match(runBlockers({ files: 1, library: 5, allRegulations: false, chosen: 0 })[0], /no regulation/);
  assert.equal(runBlockers({ files: 0, library: 0, allRegulations: false, chosen: 0 }).length, 2);
});
