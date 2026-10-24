import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAT_MAX_MESSAGE_CHARS, pageFromPath, parseChatAnswer, parseChatRequest } from "./assistant.ts";

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";

test("the page's ids come from the URL", () => {
  assert.deepEqual(pageFromPath(`/runs/${R}`), { path: `/runs/${R}`, run_id: R });
  assert.deepEqual(pageFromPath(`/projects/${P}/cases/${R}?tab=files`), {
    path: `/projects/${P}/cases/${R}`,
    case_id: R,
  });
  assert.deepEqual(pageFromPath(`/regulations/${R}`), { path: `/regulations/${R}`, regulation_id: R });
  assert.deepEqual(pageFromPath("/runs/not-an-id"), { path: "/runs/not-an-id" });
  assert.deepEqual(pageFromPath("/"), { path: "/" });
});

test("a conversation that ends with the question is accepted, trimmed, with its page", () => {
  assert.deepEqual(
    parseChatRequest({
      project_id: P,
      path: `/runs/${R}`,
      messages: [
        { role: "user", content: " Why R-001? " },
        { role: "assistant", content: "It cites 5.4.2." },
        { role: "user", content: "And R-002?" },
      ],
    }),
    {
      projectId: P,
      page: { path: `/runs/${R}`, run_id: R },
      messages: [
        { role: "user", content: "Why R-001?" },
        { role: "assistant", content: "It cites 5.4.2." },
        { role: "user", content: "And R-002?" },
      ],
    },
  );
});

test("malformed requests are refused with a reason", () => {
  const q = [{ role: "user", content: "q" }];
  for (const body of [
    null,
    {},
    { project_id: "nope", messages: q },
    { project_id: P, messages: [] },
    { project_id: P, messages: [{ role: "system", content: "x" }] },
    { project_id: P, messages: [{ role: "user", content: "   " }] },
    { project_id: P, messages: [{ role: "user", content: "x".repeat(CHAT_MAX_MESSAGE_CHARS + 1) }] },
    { project_id: P, messages: [...q, { role: "assistant", content: "a" }] },
  ]) {
    assert.equal(typeof parseChatRequest(body), "string", JSON.stringify(body)?.slice(0, 80));
  }
});

test("a path that is not a path is read as the home page", () => {
  const parsed = parseChatRequest({ project_id: P, path: "https://elsewhere", messages: [{ role: "user", content: "q" }] });
  assert.ok(typeof parsed !== "string");
  assert.deepEqual(parsed.page, { path: "/" });
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
