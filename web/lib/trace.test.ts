import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUN_STATUSES,
  type RunEventRow,
  type ToolStep,
  buildTimeline,
  canRetry,
  isStalled,
  STALLED_AFTER_MS,
  compactJson,
  describeArgs,
  formatCost,
  formatElapsed,
  formatJson,
  indentJsonText,
  formatRelativeTime,
  formatUsage,
  formatUtc,
  isApprovalRow,
  isEmptyArgs,
  isFinished,
  isLongText,
  isRunEventRow,
  isRunRow,
  mergeEvents,
  mergeRunList,
  parseEvent,
  pendingApprovals,
  readableResult,
  statusLabel,
  statusTone,
  summarizeEvent,
  summarizeRun,
  toolStepStatus,
  truncate,
  upsertById,
} from "./trace.ts";

const RUN = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const T0 = "2026-10-13T10:00:00.000Z";

let nextId = 1;
function row(kind: string, payload: unknown, at = T0): RunEventRow {
  return { id: nextId++, run_id: RUN, created_at: at, kind, payload };
}

function toolSteps(rows: RunEventRow[]): ToolStep[] {
  return buildTimeline(rows).filter((item): item is ToolStep => item.type === "tool");
}

test("every status has a label and the tone the design asks for", () => {
  assert.deepEqual(
    RUN_STATUSES.map((status) => [status, statusLabel(status), statusTone(status)]),
    [
      ["queued", "Queued", "neutral"],
      ["running", "Running", "blue"],
      ["awaiting_approval", "Awaiting approval", "amber"],
      ["succeeded", "Succeeded", "green"],
      ["failed", "Failed", "red"],
    ],
  );
});

test("a status this build does not know is shown as written, in the neutral tone", () => {
  assert.equal(statusLabel("cancelled"), "cancelled");
  assert.equal(statusTone("cancelled"), "neutral");
  // A status named like something on Object.prototype once came back with no tone at all.
  assert.equal(statusTone("toString"), "neutral");
});

test("isFinished is true only for the two end states", () => {
  assert.deepEqual(
    RUN_STATUSES.filter((status) => isFinished(status)),
    ["succeeded", "failed"],
  );
});

test("parseEvent reads each documented payload", () => {
  assert.deepEqual(parseEvent(row("status", { status: "running", detail: "step 2" })).payload, {
    status: "running",
    detail: "step 2",
  });
  assert.deepEqual(parseEvent(row("text", { text: "Looking up the bracket." })).payload, {
    text: "Looking up the bracket.",
  });
  assert.deepEqual(parseEvent(row("text", { text: "Search matched words only.", level: "warning" })).payload, {
    text: "Search matched words only.",
    warning: true,
  });
  assert.deepEqual(
    parseEvent(row("tool_call", { tool_call_id: "c1", tool_name: "plm_get_ecn", args: { id: 1 } }))
      .payload,
    { tool_call_id: "c1", tool_name: "plm_get_ecn", args: { id: 1 } },
  );
  assert.deepEqual(
    parseEvent(
      row("tool_result", { tool_call_id: "c1", tool_name: "plm_get_ecn", result: [1], is_error: false }),
    ).payload,
    { tool_call_id: "c1", tool_name: "plm_get_ecn", result: [1], is_error: false },
  );
  assert.deepEqual(
    parseEvent(
      row("approval_requested", {
        approval_id: RUN,
        tool_call_id: "c2",
        tool_name: "plm_hold_ecn",
        args: { ecn: "ECN-1001" },
      }),
    ).payload,
    { approval_id: RUN, tool_call_id: "c2", tool_name: "plm_hold_ecn", args: { ecn: "ECN-1001" } },
  );
  assert.deepEqual(
    parseEvent(
      row("approval_resolved", {
        tool_call_id: "c2",
        tool_name: "plm_hold_ecn",
        decision: "denied",
        note: null,
      }),
    ).payload,
    { tool_call_id: "c2", tool_name: "plm_hold_ecn", decision: "denied", note: null },
  );
  assert.deepEqual(parseEvent(row("error", { message: "boom" })).payload, { message: "boom" });
});

test("parseEvent turns an unknown kind or a malformed payload into an 'unknown' event", () => {
  const future = parseEvent(row("handoff", { to: "another agent" }));
  assert.equal(future.kind, "unknown");
  assert.equal(future.kind === "unknown" && future.rawKind, "handoff");

  const malformed: [string, unknown][] = [
    ["status", {}],
    ["text", { text: 5 }],
    ["tool_call", { tool_name: "x" }],
    ["tool_result", { tool_call_id: "c1" }],
    ["approval_requested", { tool_call_id: "c1", tool_name: "x" }],
    ["approval_resolved", { tool_call_id: "c1", tool_name: "x", decision: "maybe" }],
    ["error", { message: null }],
    ["text", null],
    ["text", "just a string"],
    ["text", ["an", "array"]],
  ];
  for (const [kind, payload] of malformed) {
    const parsed = parseEvent(row(kind, payload));
    assert.equal(parsed.kind, "unknown", `${kind} ${JSON.stringify(payload)}`);
    assert.equal(typeof summarizeEvent(parsed), "string");
  }
});

test("parseEvent fills the optional parts of a tool payload", () => {
  const call = parseEvent(row("tool_call", { tool_call_id: "c1", tool_name: "x" }));
  assert.deepEqual(call.kind === "tool_call" && call.payload.args, {});
  const result = parseEvent(row("tool_result", { tool_call_id: "c1", tool_name: "x" }));
  assert.deepEqual(result.kind === "tool_result" && result.payload, {
    tool_call_id: "c1",
    tool_name: "x",
    result: null,
    is_error: false,
  });
});

test("summarizeEvent gives one line per kind", () => {
  const lines = [
    row("status", { status: "awaiting_approval" }),
    row("status", { status: "failed", detail: "model refused" }),
    row("text", { text: "First line.\n\nSecond line." }),
    row("tool_call", { tool_call_id: "c1", tool_name: "erp_open_orders", args: { part: "BR-200" } }),
    row("tool_result", { tool_call_id: "c1", tool_name: "erp_open_orders", result: { orders: 3 }, is_error: false }),
    row("tool_result", { tool_call_id: "c1", tool_name: "erp_open_orders", result: "timeout", is_error: true }),
    row("approval_requested", { approval_id: RUN, tool_call_id: "c2", tool_name: "plm_hold_ecn", args: {} }),
    row("approval_resolved", { tool_call_id: "c2", tool_name: "plm_hold_ecn", decision: "approved", note: "go" }),
    row("approval_resolved", { tool_call_id: "c2", tool_name: "plm_hold_ecn", decision: "denied", note: null }),
    row("error", { message: "boom" }),
    row("handoff", {}),
  ].map((r) => summarizeEvent(parseEvent(r)));

  assert.deepEqual(lines, [
    "Awaiting approval",
    "Failed: model refused",
    "First line. Second line.",
    'Called erp_open_orders({"part":"BR-200"})',
    'erp_open_orders returned {"orders":3}',
    "erp_open_orders failed: timeout",
    "Approval requested for plm_hold_ecn",
    "Approved plm_hold_ecn: go",
    "Denied plm_hold_ecn",
    "Error: boom",
    'Unrecognised event "handoff"',
  ]);
  for (const line of lines) assert.equal(line.includes("\n"), false);
});

test("buildTimeline pairs a call with its result by tool_call_id, not by position", () => {
  const items = buildTimeline([
    row("status", { status: "running" }),
    row("tool_call", { tool_call_id: "a", tool_name: "plm_where_used", args: { part: "BR-200" } }),
    row("tool_call", { tool_call_id: "b", tool_name: "erp_open_orders", args: { part: "BR-200" } }),
    row("tool_result", { tool_call_id: "b", tool_name: "erp_open_orders", result: [], is_error: false }, "2026-10-13T10:00:02.000Z"),
    row("tool_result", { tool_call_id: "a", tool_name: "plm_where_used", result: ["ASM-7"], is_error: false }),
    row("text", { text: "Two assemblies use it." }),
  ]);

  assert.deepEqual(
    items.map((item) => (item.type === "tool" ? item.toolName : item.event.kind)),
    ["status", "plm_where_used", "erp_open_orders", "text"],
  );
  const [a, b] = items.filter((item): item is ToolStep => item.type === "tool");
  assert.deepEqual(a.result?.value, ["ASM-7"]);
  assert.deepEqual(a.args, { part: "BR-200" });
  assert.deepEqual(b.result, { value: [], isError: false, at: "2026-10-13T10:00:02.000Z" });
  assert.equal(new Set(items.map((item) => item.key)).size, items.length);
});

test("buildTimeline folds the approval into the tool step, whichever event comes first", () => {
  const requestFirst = toolSteps([
    row("approval_requested", { approval_id: RUN, tool_call_id: "h", tool_name: "plm_hold_ecn", args: { ecn: "ECN-1001" } }),
    row("status", { status: "awaiting_approval" }),
    row("approval_resolved", { tool_call_id: "h", tool_name: "plm_hold_ecn", decision: "approved", note: "ok" }),
    row("tool_call", { tool_call_id: "h", tool_name: "plm_hold_ecn", args: { ecn: "ECN-1001" } }),
    row("tool_result", { tool_call_id: "h", tool_name: "plm_hold_ecn", result: "held", is_error: false }),
  ]);
  assert.equal(requestFirst.length, 1);
  assert.deepEqual(requestFirst[0].approval, { state: "approved", note: "ok" });
  assert.equal(requestFirst[0].result?.value, "held");

  const callFirst = toolSteps([
    row("tool_call", { tool_call_id: "h", tool_name: "plm_hold_ecn", args: { ecn: "ECN-1001" } }),
    row("approval_requested", { approval_id: RUN, tool_call_id: "h", tool_name: "plm_hold_ecn", args: { ecn: "ECN-1001" } }),
  ]);
  assert.equal(callFirst.length, 1);
  assert.deepEqual(callFirst[0].approval, { state: "requested", note: null });
  assert.deepEqual(callFirst[0].args, { ecn: "ECN-1001" });
});

test("a late approval_requested does not undo a decision already seen", () => {
  const [step] = toolSteps([
    row("approval_resolved", { tool_call_id: "h", tool_name: "plm_hold_ecn", decision: "denied", note: null }),
    row("approval_requested", { approval_id: RUN, tool_call_id: "h", tool_name: "plm_hold_ecn", args: {} }),
  ]);
  assert.deepEqual(step.approval, { state: "denied", note: null });
});

test("buildTimeline keeps a result that has no call", () => {
  const [step] = toolSteps([
    row("tool_result", { tool_call_id: "lost", tool_name: "cad_check_fit", result: { fits: true }, is_error: false }),
  ]);
  assert.equal(step.toolName, "cad_check_fit");
  assert.deepEqual(step.args, {});
  assert.deepEqual(step.result?.value, { fits: true });
});

test("buildTimeline keeps unknown and malformed events as plain rows", () => {
  const items = buildTimeline([row("handoff", { to: "x" }), row("tool_call", "broken")]);
  assert.deepEqual(
    items.map((item) => item.type === "event" && item.event.kind),
    ["unknown", "unknown"],
  );
});

test("toolStepStatus reflects the result, the approval and whether the run is over", () => {
  const base: ToolStep = {
    type: "tool",
    key: "tool:x",
    toolCallId: "x",
    toolName: "t",
    args: {},
    startedAt: T0,
    approval: null,
    result: null,
  };
  const status = (patch: Partial<ToolStep>, finished = false) =>
    toolStepStatus({ ...base, ...patch }, finished);

  assert.deepEqual(status({}), { label: "Running", tone: "blue" });
  assert.deepEqual(status({}, true), { label: "No result", tone: "neutral" });
  assert.deepEqual(status({ approval: { state: "requested", note: null } }), {
    label: "Awaiting approval",
    tone: "amber",
  });
  assert.deepEqual(status({ approval: { state: "requested", note: null } }, true), {
    label: "Not decided",
    tone: "neutral",
  });
  assert.deepEqual(status({ approval: { state: "denied", note: null } }), { label: "Denied", tone: "red" });
  assert.deepEqual(status({ approval: { state: "approved", note: null } }), { label: "Running", tone: "blue" });
  assert.deepEqual(status({ result: { value: 1, isError: false, at: T0 } }), { label: "Done", tone: "green" });
  assert.deepEqual(
    status({ approval: { state: "denied", note: null }, result: { value: "denied", isError: true, at: T0 } }),
    { label: "Error", tone: "red" },
  );
});

test("mergeEvents drops duplicates, keeps id order and returns the same array when nothing is new", () => {
  const current = [{ id: 1 }, { id: 2 }, { id: 5 }];
  assert.equal(mergeEvents(current, [{ id: 2 }, { id: 5 }]), current);
  assert.equal(mergeEvents(current, []), current);
  assert.deepEqual(mergeEvents(current, [{ id: 4 }, { id: 3 }, { id: 4 }, { id: 1 }]), [
    { id: 1 },
    { id: 2 },
    { id: 3 },
    { id: 4 },
    { id: 5 },
  ]);
});

test("mergeEvents never replaces a row it already holds", () => {
  const first = { id: 1, payload: "from the server render" };
  const merged = mergeEvents([first], [{ id: 1, payload: "from realtime" }]);
  assert.equal(merged[0], first);
});

test("upsertById replaces a changed row and appends a new one", () => {
  const current = [
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
  ];
  assert.deepEqual(
    upsertById(current, [
      { id: "b", status: "approved" },
      { id: "c", status: "pending" },
    ]),
    [
      { id: "a", status: "pending" },
      { id: "b", status: "approved" },
      { id: "c", status: "pending" },
    ],
  );
});

test("canRetry: queued, or awaiting approval with nothing left to decide", () => {
  const pending = { status: "pending" };
  const approved = { status: "approved" };
  assert.equal(canRetry("queued", []), true);
  assert.equal(canRetry("queued", [pending]), true);
  assert.equal(canRetry("awaiting_approval", []), true);
  assert.equal(canRetry("awaiting_approval", [approved]), true);
  assert.equal(canRetry("awaiting_approval", [approved, pending]), false);
  assert.equal(canRetry("running", []), false);
  assert.equal(canRetry("succeeded", []), false);
  assert.equal(canRetry("failed", []), false);
  assert.deepEqual(pendingApprovals([approved, pending]), [pending]);
});

test("isStalled: only a running run whose heartbeat is older than the threshold", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const fresh = new Date(now - 20_000).toISOString();
  const old = new Date(now - STALLED_AFTER_MS - 1).toISOString();
  assert.equal(isStalled("running", fresh, now), false);
  assert.equal(isStalled("running", old, now), true);
  // Waiting for a person is silence too, and it is not a fault.
  assert.equal(isStalled("awaiting_approval", old, now), false);
  assert.equal(isStalled("succeeded", old, now), false);
  assert.equal(isStalled("running", "not a date", now), false);
});

test("formatUsage shows what is present and nothing for an empty object", () => {
  assert.deepEqual(formatUsage({}), []);
  assert.deepEqual(formatUsage(null), []);
  assert.deepEqual(formatUsage("12"), []);
  assert.deepEqual(
    formatUsage({ input_tokens: 12345, output_tokens: 678, requests: 4, tool_calls: 1, cost_usd: 0.0421 }),
    ["12,345 in / 678 out tokens", "4 requests", "1 tool call", "$0.04"],
  );
  assert.deepEqual(formatUsage({ input_tokens: 1, requests: 1, cost_usd: null }), ["1 input token", "1 request"]);
  assert.deepEqual(formatUsage({ output_tokens: 20 }), ["20 output tokens"]);
  assert.deepEqual(formatUsage({ input_tokens: "many", cost_usd: -1, requests: Number.NaN }), []);
});

test("formatCost keeps sub-cent costs visible", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.00042), "$0.0004");
  assert.equal(formatCost(0.0421), "$0.04");
  assert.equal(formatCost(12.5), "$12.50");
});

test("truncate flattens whitespace and cuts with an ellipsis", () => {
  assert.equal(truncate("  a\n\n b\tc  "), "a b c");
  assert.equal(truncate("x".repeat(120)), "x".repeat(120));
  const cut = truncate("x".repeat(121));
  assert.equal(cut.length, 120);
  assert.equal(cut.endsWith("…"), true);
});

test("formatJson shows strings raw and everything else indented", () => {
  assert.equal(formatJson("line 1\nline 2"), "line 1\nline 2");
  assert.equal(formatJson({ a: [1, 2] }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(formatJson(null), "null");
  assert.equal(formatJson(undefined), "");
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(typeof formatJson(loop), "string");
});

test("compactJson is one short line", () => {
  assert.equal(compactJson({ part: "BR-200" }), '{"part":"BR-200"}');
  assert.equal(compactJson("x".repeat(200), 20).length, 20);
});

test("isLongText looks at both characters and lines", () => {
  assert.equal(isLongText("short"), false);
  assert.equal(isLongText("x".repeat(601)), true);
  assert.equal(isLongText("a\n".repeat(12)), true);
  assert.equal(isLongText("a\n".repeat(11)), false);
});

test("describeArgs lists top-level keys and gives up on anything that is not an object", () => {
  assert.deepEqual(describeArgs({ ecn: "ECN-1001", reason: "collides with\nASM-7", parts: ["BR-200"] }), [
    { name: "ecn", value: "ECN-1001" },
    { name: "reason", value: "collides with\nASM-7" },
    { name: "parts", value: '[\n  "BR-200"\n]' },
  ]);
  assert.deepEqual(describeArgs({}), []);
  assert.equal(describeArgs(["a"]), null);
  assert.equal(describeArgs("a"), null);
  assert.equal(describeArgs(null), null);
});

test("isEmptyArgs is true only when there is nothing to show", () => {
  assert.equal(isEmptyArgs({}), true);
  assert.equal(isEmptyArgs(null), true);
  assert.equal(isEmptyArgs(undefined), true);
  assert.equal(isEmptyArgs({ part: "BR-200" }), false);
  assert.equal(isEmptyArgs([]), false);
  assert.equal(isEmptyArgs("BR-200"), false);
  assert.equal(isEmptyArgs(0), false);
});

test("isRunEventRow accepts a full row and rejects a truncated one", () => {
  assert.equal(isRunEventRow(row("text", { text: "hi" })), true);
  assert.equal(isRunEventRow({ id: 1, run_id: RUN, created_at: T0, kind: "text" }), false);
  assert.equal(isRunEventRow({ id: "1", run_id: RUN, created_at: T0, kind: "text", payload: {} }), false);
  assert.equal(isRunEventRow(null), false);
});

test("isRunRow and isApprovalRow reject rows that realtime sent without their large columns", () => {
  const run = {
    id: RUN,
    created_at: T0,
    updated_at: T0,
    created_by: RUN,
    task: "t",
    status: "running",
    model: null,
    output: null,
    error: null,
    usage: {},
  };
  assert.equal(isRunRow(run), true);
  assert.equal(isRunRow({ id: RUN, created_at: T0, status: "running" }), false);
  assert.equal(isRunRow({}), false);

  const approval = {
    id: RUN,
    run_id: RUN,
    created_at: T0,
    tool_call_id: "c1",
    tool_name: "plm_hold_ecn",
    args: {},
    status: "pending",
    note: null,
    decided_by: null,
    decided_at: null,
  };
  assert.equal(isApprovalRow(approval), true);
  assert.equal(isApprovalRow({ id: RUN, run_id: RUN, status: "pending" }), false);
});

test("summarizeRun keeps only a short preview of the task", () => {
  const summary = summarizeRun({
    id: RUN,
    created_at: T0,
    status: "queued",
    model: "anthropic:claude-opus-5-5",
    task: `Triage ECN-1001:\n${"x".repeat(500)}`,
  });
  assert.equal(summary.preview.length, 120);
  assert.equal(summary.preview.startsWith("Triage ECN-1001: x"), true);
  assert.deepEqual(Object.keys(summary).sort(), ["created_at", "id", "model", "preview", "status"]);
});

test("mergeRunList updates in place, sorts newest first and caps the list", () => {
  const run = (id: string, minute: number, status = "queued") => ({
    id,
    created_at: `2026-10-13T10:${String(minute).padStart(2, "0")}:00.000Z`,
    status,
    model: null,
    preview: id,
  });
  const merged = mergeRunList([run("b", 2), run("a", 1)], [run("c", 3), run("a", 1, "running")], 10);
  assert.deepEqual(
    merged.map((r) => [r.id, r.status]),
    [
      ["c", "queued"],
      ["b", "queued"],
      ["a", "running"],
    ],
  );
  assert.deepEqual(
    mergeRunList(merged, [run("d", 4)], 2).map((r) => r.id),
    ["d", "c"],
  );
});

test("formatRelativeTime steps through seconds, minutes, hours, days and then a date", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  const ago = (ms: number) => formatRelativeTime(new Date(now - ms).toISOString(), now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(44_000), "just now");
  assert.equal(ago(5 * 60_000), "5 min ago");
  assert.equal(ago(3 * 3_600_000), "3 h ago");
  assert.equal(ago(2 * 86_400_000), "2 d ago");
  assert.equal(ago(45 * 86_400_000), "2026-08-29");
  assert.equal(formatRelativeTime("2026-10-13T12:00:05.000Z", now), "just now");
  assert.equal(formatRelativeTime("not a date", now), "");
});

test("formatUtc and formatElapsed do not depend on the local time zone", () => {
  assert.equal(formatUtc("2026-10-13T10:07:42.123+02:00"), "2026-10-13 08:07 UTC");
  assert.equal(formatUtc("nope"), "");
  assert.equal(formatElapsed(T0, T0), "+0.0s");
  assert.equal(formatElapsed(T0, "2026-10-13T10:00:03.240Z"), "+3.2s");
  assert.equal(formatElapsed(T0, "2026-10-13T10:01:05.900Z"), "+1m 05s");
  assert.equal(formatElapsed(T0, "2026-10-13T12:07:30.000Z"), "+2h 07m");
  assert.equal(formatElapsed(T0, "2026-10-13T09:59:59.000Z"), "+0.0s");
  assert.equal(formatElapsed(T0, "nope"), "");
});

test("a case file event says what was read and what was not", async () => {
  const { parseEvent, summarizeEvent } = await import("./trace.ts");
  const row = (payload: unknown): RunEventRow => ({
    id: 1,
    run_id: "r",
    created_at: "2026-10-24T15:00:00Z",
    kind: "case_file",
    payload,
  });
  const pdf = parseEvent(
    row({
      filename: "datasheet.pdf",
      format: "pdf",
      bytes: 120000,
      pages: 12,
      characters: 30100,
      images: 2,
      notes: ["Little or no text on page(s) 3, 7; sent as images."],
      error: null,
    }),
  );
  assert.equal(
    summarizeEvent(pdf),
    "Read datasheet.pdf: 12 pages, 30,100 characters, 2 images. Little or no text on page(s) 3, 7; sent as images.",
  );
  const broken = parseEvent(row({ filename: "x.pdf", format: "pdf", error: "Could not be read: PdfReadError" }));
  assert.equal(summarizeEvent(broken), "x.pdf: Could not be read: PdfReadError");
  assert.equal(parseEvent(row({ format: "pdf" })).kind, "unknown");
});

test("formatDuration reads at a glance", async () => {
  const { formatDuration } = await import("./trace.ts");
  assert.equal(formatDuration(45_000), "45 s");
  assert.equal(formatDuration(200_000), "3 min 20 s");
  assert.equal(formatDuration(3_900_000), "1 h 05 min");
  assert.equal(formatDuration(-1), "");
});

test("describeActivity names the step in progress, newest first", async () => {
  const { describeActivity } = await import("./trace.ts");
  const row = (id: number, kind: string, payload: unknown) => ({ id, run_id: "r", created_at: "2026-10-24T18:00:00Z", kind, payload });
  assert.equal(describeActivity([]), "Waiting for the agent to pick it up…");
  assert.equal(describeActivity([row(1, "status", { status: "running" })]), "Started: reading the part…");
  const call = row(2, "tool_call", { tool_call_id: "c1", tool_name: "write_requirements", args: {} });
  assert.equal(describeActivity([row(1, "status", { status: "running" }), call]), "Running write_requirements…");
  const result = row(3, "tool_result", { tool_call_id: "c1", tool_name: "write_requirements", result: 1 });
  assert.match(describeActivity([call, result]), /finished; the model is deciding/);
  assert.equal(describeActivity([call, row(4, "text", { text: "\nChecking 40 requirements in 2 batch(es).\nmore" })]), "Checking 40 requirements in 2 batch(es).");
});

test("describeResult counts requirements and keeps plain text as it is", async () => {
  const { describeResult } = await import("./trace.ts");
  const json = describeResult('{"team_id":"t","requirements":[{"a":1},{"a":2}]}');
  assert.equal(json.json, true);
  assert.match(json.summary, /^2 requirements, \d+ characters$/);
  assert.equal(describeResult("Done.\nNo requirements.").json, false);
  assert.equal(describeResult("Done.\nNo requirements.").summary, "2 lines");
});

test("a result cut by an older agent is shown indented, not as one escaped line", () => {
  const preview = '[{"regulation": "UN R1", "tags": [], "scope": "a, b: \\"c\\""}, {"regulation": "UN R2", "sc';
  const shown = readableResult({ truncated: true, preview });
  assert.equal(
    shown,
    [
      "[",
      "  {",
      '    "regulation": "UN R1",',
      '    "tags": [],',
      '    "scope": "a, b: \\"c\\""',
      "  },",
      "  {",
      '    "regulation": "UN R2",',
      '    "sc',
      "… cut here: the rest was not kept in the trace",
    ].join("\n"),
  );
});

test("readableResult leaves every other result as it is", () => {
  const value = { truncated: true, preview: "x", count: 3 };
  assert.equal(readableResult(value), value);
  assert.deepEqual(readableResult([1, 2]), [1, 2]);
  assert.equal(indentJsonText("{}"), "{}");
});
