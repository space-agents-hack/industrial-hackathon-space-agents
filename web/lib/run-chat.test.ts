import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAT_MAX_MESSAGE_CHARS, parseChatAnswer, parseChatRequest } from "./run-chat.ts";

test("a conversation that ends with the question is accepted, trimmed", () => {
  assert.deepEqual(
    parseChatRequest({
      messages: [
        { role: "user", content: " Why R-001? " },
        { role: "assistant", content: "It cites 5.4.2." },
        { role: "user", content: "And R-002?" },
      ],
    }),
    [
      { role: "user", content: "Why R-001?" },
      { role: "assistant", content: "It cites 5.4.2." },
      { role: "user", content: "And R-002?" },
    ],
  );
});

test("malformed conversations are refused with a reason", () => {
  for (const body of [
    null,
    {},
    { messages: [] },
    { messages: [{ role: "system", content: "x" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "x".repeat(CHAT_MAX_MESSAGE_CHARS + 1) }] },
    { messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] },
  ]) {
    assert.equal(typeof parseChatRequest(body), "string", JSON.stringify(body)?.slice(0, 80));
  }
});

test("the agent's answer is read with its cost when it has one", () => {
  assert.deepEqual(
    parseChatAnswer({ answer: "R-001 cites 5.4.2.", model: "scripted", usage: { cost_usd: 0.012 } }),
    { answer: "R-001 cites 5.4.2.", model: "scripted", costUsd: 0.012 },
  );
  assert.deepEqual(parseChatAnswer({ answer: "ok", model: "m", usage: { cost_usd: null } }), {
    answer: "ok",
    model: "m",
    costUsd: null,
  });
  assert.equal(parseChatAnswer({ answer: 1 }), null);
  assert.equal(parseChatAnswer("ok"), null);
});
