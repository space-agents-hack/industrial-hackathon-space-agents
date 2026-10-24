import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeSearch,
  indexComplete,
  libraryIndex,
  parseIndexStatus,
  parseIndexStream,
  shouldContinue,
  vectorKey,
  versionSummary,
} from "./regulation-index.ts";

const MODEL = "openai:text-embedding-3-small";

const summary = (over: Partial<Parameters<typeof versionSummary>[0]> = {}) =>
  versionSummary({
    scope_summary: "Rear position lamps of M and N vehicles.",
    scope_keywords: ["tail lamp"],
    summary_model: "anthropic:claude-haiku-5-5",
    summarized_at: "2026-10-24T19:40:00Z",
    summary_sha256: "a",
    sha256: "a",
    ...over,
  });

test("counts only the vectors of the model searches use now", () => {
  const status = parseIndexStatus([
    { version_id: "v1", paragraphs: 10, keyed: 10, vectors: { [vectorKey(MODEL)]: 10, "other@1024": 3 }, last_embedded_at: null },
    { version_id: "v2", paragraphs: 5, keyed: 2, vectors: {}, last_embedded_at: null },
  ]);
  const index = libraryIndex(status, [summary(), summary({ scope_summary: null })], MODEL);
  assert.deepEqual(index, { paragraphs: 15, embedded: 10, unkeyed: 3, versions: 2, summarized: 1 });
  assert.equal(indexComplete(index), false);
});

test("a summary of an older file is not counted, and says so", () => {
  const stale = summary({ summary_sha256: "old" });
  assert.equal(stale.stale, true);
  assert.equal(libraryIndex(new Map(), [stale], MODEL).summarized, 0);
});

test("a library without vectors says that searches match words only", () => {
  const none = libraryIndex(parseIndexStatus([{ version_id: "v", paragraphs: 4, keyed: 0, vectors: {} }]), [], MODEL);
  assert.match(describeSearch(none).text, /words only/);
  assert.equal(describeSearch(none).tone, "attention");
  const full = libraryIndex(parseIndexStatus([{ version_id: "v", paragraphs: 4, keyed: 4, vectors: { [vectorKey(MODEL)]: 4 } }]), [], MODEL);
  assert.equal(describeSearch(full).tone, "ok");
});

test("reads the last line of the agent's stream", () => {
  const stream = [
    JSON.stringify({ event: "accepted" }),
    JSON.stringify({ event: "heartbeat" }),
    JSON.stringify({ event: "done", status: "paused", finished: false, embedded: 500, summarized: 0, pruned: 0, keys_changed: 48487, notes: [] }),
    "",
  ].join("\n");
  const slice = parseIndexStream(stream);
  assert.deepEqual(slice, { status: "paused", embedded: 500, summarized: 0, pruned: 0, keysChanged: 48487, notes: [] });
  assert.ok(slice && shouldContinue(slice));
  assert.deepEqual(parseIndexStream(JSON.stringify({ event: "done", status: "failed", error: "openai rejected the API key." })), {
    status: "failed",
    error: "openai rejected the API key.",
  });
  assert.equal(parseIndexStream(JSON.stringify({ event: "accepted" })), null);
});

test("a slice that wrote nothing stops the loop instead of asking forever", () => {
  const stuck = parseIndexStream(
    JSON.stringify({ event: "done", status: "paused", finished: false, embedded: 0, summarized: 0, notes: ["No openai key"] }),
  );
  assert.ok(stuck);
  assert.equal(shouldContinue(stuck), false);
});
