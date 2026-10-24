// Pure helpers for showing a run: payload types, labels, pairing and formatting.
// No React and no Supabase imports, so `node --test` can run the tests without a bundler.

export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type Tone = "neutral" | "blue" | "amber" | "green" | "red";

const STATUS_META: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "blue" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber" },
  succeeded: { label: "Succeeded", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && Object.hasOwn(STATUS_META, value);
}

// The database stores status as text with a check, so a newer agent can write a value this build
// has never seen. Show it as it is instead of failing.
export function statusLabel(status: string): string {
  return isRunStatus(status) ? STATUS_META[status].label : status;
}

export function statusTone(status: string): Tone {
  return isRunStatus(status) ? STATUS_META[status].tone : "neutral";
}

export function isFinished(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

// ---------------------------------------------------------------------------------------------
// Rows, as the web reads them. Structural, so the generated database types are assignable.
// ---------------------------------------------------------------------------------------------

export type RunEventRow = {
  id: number;
  run_id: string;
  created_at: string;
  kind: string;
  payload: unknown;
};

export type RunRow = {
  id: string;
  // Optional so rows built by hand (tests, older Realtime payloads) still fit; the database
  // always has it.
  organization_id?: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  task: string;
  status: string;
  model: string | null;
  output: string | null;
  error: string | null;
  usage: unknown;
};

export type ApprovalRow = {
  id: string;
  run_id: string;
  created_at: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
  status: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

export type ApprovalLike = { status: string };

// What the run list keeps per run. `preview` is the start of the task, never the whole text.
export type RunSummary = {
  id: string;
  created_at: string;
  status: string;
  model: string | null;
  preview: string;
};

// ---------------------------------------------------------------------------------------------
// Event payloads written by the agent.
// ---------------------------------------------------------------------------------------------

export type StatusPayload = { status: string; detail?: string };
export type TextPayload = { text: string };
export type ToolCallPayload = { tool_call_id: string; tool_name: string; args: unknown };
export type ToolResultPayload = {
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  is_error: boolean;
};
export type ApprovalRequestedPayload = {
  approval_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
};
export type ApprovalResolvedPayload = {
  tool_call_id: string;
  tool_name: string;
  decision: "approved" | "denied";
  note: string | null;
};
export type ErrorPayload = { message: string };
// One per uploaded case file, written before the model starts (agent/agent_service/domain/ingest.py).
export type CaseFilePayload = {
  filename: string;
  format: string;
  bytes: number;
  pages: number | null;
  characters: number;
  images: number;
  notes: string[];
  error: string | null;
};

type EventBase = { id: number; createdAt: string };

export type ParsedEvent = EventBase &
  (
    | { kind: "status"; payload: StatusPayload }
    | { kind: "text"; payload: TextPayload }
    | { kind: "tool_call"; payload: ToolCallPayload }
    | { kind: "tool_result"; payload: ToolResultPayload }
    | { kind: "approval_requested"; payload: ApprovalRequestedPayload }
    | { kind: "approval_resolved"; payload: ApprovalResolvedPayload }
    | { kind: "error"; payload: ErrorPayload }
    | { kind: "case_file"; payload: CaseFilePayload }
    // A kind this build does not know, or a known kind whose payload is not the expected shape.
    | { kind: "unknown"; rawKind: string; payload: unknown }
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseEvent(row: RunEventRow): ParsedEvent {
  const base: EventBase = { id: row.id, createdAt: row.created_at };
  const p = row.payload;
  const unknown: ParsedEvent = { ...base, kind: "unknown", rawKind: row.kind, payload: p };
  if (!isRecord(p)) return unknown;

  switch (row.kind) {
    case "status":
      if (!isString(p.status)) return unknown;
      return {
        ...base,
        kind: "status",
        payload: { status: p.status, ...(isString(p.detail) ? { detail: p.detail } : {}) },
      };
    case "text":
      if (!isString(p.text)) return unknown;
      return { ...base, kind: "text", payload: { text: p.text } };
    case "tool_call":
      if (!isString(p.tool_call_id) || !isString(p.tool_name)) return unknown;
      return {
        ...base,
        kind: "tool_call",
        payload: { tool_call_id: p.tool_call_id, tool_name: p.tool_name, args: p.args ?? {} },
      };
    case "tool_result":
      if (!isString(p.tool_call_id) || !isString(p.tool_name)) return unknown;
      return {
        ...base,
        kind: "tool_result",
        payload: {
          tool_call_id: p.tool_call_id,
          tool_name: p.tool_name,
          result: p.result ?? null,
          is_error: p.is_error === true,
        },
      };
    case "approval_requested":
      if (!isString(p.tool_call_id) || !isString(p.tool_name) || !isString(p.approval_id)) {
        return unknown;
      }
      return {
        ...base,
        kind: "approval_requested",
        payload: {
          approval_id: p.approval_id,
          tool_call_id: p.tool_call_id,
          tool_name: p.tool_name,
          args: p.args ?? {},
        },
      };
    case "approval_resolved":
      if (!isString(p.tool_call_id) || !isString(p.tool_name)) return unknown;
      if (p.decision !== "approved" && p.decision !== "denied") return unknown;
      return {
        ...base,
        kind: "approval_resolved",
        payload: {
          tool_call_id: p.tool_call_id,
          tool_name: p.tool_name,
          decision: p.decision,
          note: isString(p.note) && p.note !== "" ? p.note : null,
        },
      };
    case "error":
      if (!isString(p.message)) return unknown;
      return { ...base, kind: "error", payload: { message: p.message } };
    case "case_file":
      if (!isString(p.filename) || !isString(p.format)) return unknown;
      return {
        ...base,
        kind: "case_file",
        payload: {
          filename: p.filename,
          format: p.format,
          bytes: typeof p.bytes === "number" ? p.bytes : 0,
          pages: typeof p.pages === "number" ? p.pages : null,
          characters: typeof p.characters === "number" ? p.characters : 0,
          images: typeof p.images === "number" ? p.images : 0,
          notes: Array.isArray(p.notes) ? p.notes.filter(isString) : [],
          error: isString(p.error) && p.error !== "" ? p.error : null,
        },
      };
    default:
      return unknown;
  }
}

// Realtime sends a row without its large columns when the change is too big for one message.
// Anything that does not look like a full row is treated as "something changed, read it again".
export function isRunEventRow(value: unknown): value is RunEventRow {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    isString(value.run_id) &&
    isString(value.created_at) &&
    isString(value.kind) &&
    isRecord(value.payload)
  );
}

export function isRunRow(value: unknown): value is RunRow {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.created_at) &&
    isString(value.status) &&
    isString(value.task) &&
    "usage" in value
  );
}

export function isApprovalRow(value: unknown): value is ApprovalRow {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.run_id) &&
    isString(value.status) &&
    isString(value.tool_call_id) &&
    isString(value.tool_name) &&
    "args" in value
  );
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

export function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

// Strings are shown as they are; quoting them would turn every newline into a literal "\n".
export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function compactJson(value: unknown, max = 80): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = String(value);
  }
  return truncate(text, max);
}

export function isLongText(text: string, maxLines = 12, maxChars = 600): boolean {
  if (text.length > maxChars) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > maxLines) return true;
  }
  return false;
}

// A tool called with no arguments is common; an empty box under it would only add noise.
export function isEmptyArgs(args: unknown): boolean {
  if (args === null || args === undefined) return true;
  return isRecord(args) && Object.keys(args).length === 0;
}

export type ArgEntry = { name: string; value: string };

// Top-level keys of a tool's arguments, each as text a person can read before approving.
// Returns null when the arguments are not an object, so the caller can fall back to raw JSON.
export function describeArgs(args: unknown): ArgEntry[] | null {
  if (!isRecord(args)) return null;
  return Object.entries(args).map(([name, value]) => ({ name, value: formatJson(value) }));
}

export function summarizeEvent(event: ParsedEvent): string {
  switch (event.kind) {
    case "status": {
      const label = statusLabel(event.payload.status);
      return event.payload.detail ? `${label}: ${truncate(event.payload.detail, 140)}` : label;
    }
    case "text":
      return truncate(event.payload.text, 140);
    case "tool_call":
      return `Called ${event.payload.tool_name}(${compactJson(event.payload.args)})`;
    case "tool_result":
      return event.payload.is_error
        ? `${event.payload.tool_name} failed: ${compactJson(event.payload.result)}`
        : `${event.payload.tool_name} returned ${compactJson(event.payload.result)}`;
    case "approval_requested":
      return `Approval requested for ${event.payload.tool_name}`;
    case "approval_resolved": {
      const verb = event.payload.decision === "approved" ? "Approved" : "Denied";
      const note = event.payload.note ? `: ${truncate(event.payload.note, 100)}` : "";
      return `${verb} ${event.payload.tool_name}${note}`;
    }
    case "error":
      return `Error: ${truncate(event.payload.message, 140)}`;
    case "case_file":
      return describeCaseFile(event.payload);
    case "unknown":
      return `Unrecognised event "${event.rawKind}"`;
  }
}

// What the agent read from one case file, in one line. Notes say what was skipped or cut, so the
// engineer can tell whether the agent had the whole case.
export function describeCaseFile(p: CaseFilePayload): string {
  if (p.error) return `${p.filename}: ${truncate(p.error, 140)}`;
  const read: string[] = [];
  if (p.pages !== null) read.push(`${p.pages} page${p.pages === 1 ? "" : "s"}`);
  if (p.characters > 0) read.push(`${p.characters.toLocaleString("en")} characters`);
  if (p.images > 0) read.push(`${p.images} image${p.images === 1 ? "" : "s"}`);
  const notes = p.notes.length ? `. ${p.notes.join(" ")}` : "";
  return `Read ${p.filename}: ${read.join(", ") || "nothing"}${notes}`;
}

// ---------------------------------------------------------------------------------------------
// Timeline: a tool call, its approval and its result are one step, joined by tool_call_id.
// ---------------------------------------------------------------------------------------------

export type ToolStep = {
  type: "tool";
  key: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: string;
  approval: { state: "requested" | "approved" | "denied"; note: string | null } | null;
  result: { value: unknown; isError: boolean; at: string } | null;
};

export type EventStep = { type: "event"; key: string; event: ParsedEvent };

export type TimelineItem = ToolStep | EventStep;

// Each step sits where its first event appeared. The agent may write the approval request before
// or after the tool call, and a result can arrive with no call at all (an old run, a dropped
// event); none of those orders may lose information.
export function buildTimeline(rows: readonly RunEventRow[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const steps = new Map<string, ToolStep>();

  const stepFor = (toolCallId: string, toolName: string, at: string): ToolStep => {
    let step = steps.get(toolCallId);
    if (!step) {
      step = {
        type: "tool",
        key: `tool:${toolCallId}`,
        toolCallId,
        toolName,
        args: {},
        startedAt: at,
        approval: null,
        result: null,
      };
      steps.set(toolCallId, step);
      items.push(step);
    }
    return step;
  };

  for (const row of rows) {
    const event = parseEvent(row);
    switch (event.kind) {
      case "tool_call": {
        const step = stepFor(event.payload.tool_call_id, event.payload.tool_name, event.createdAt);
        step.args = event.payload.args;
        break;
      }
      case "approval_requested": {
        const step = stepFor(event.payload.tool_call_id, event.payload.tool_name, event.createdAt);
        step.args = event.payload.args;
        step.approval ??= { state: "requested", note: null };
        break;
      }
      case "approval_resolved": {
        const step = stepFor(event.payload.tool_call_id, event.payload.tool_name, event.createdAt);
        step.approval = { state: event.payload.decision, note: event.payload.note };
        break;
      }
      case "tool_result": {
        const step = stepFor(event.payload.tool_call_id, event.payload.tool_name, event.createdAt);
        step.result = {
          value: event.payload.result,
          isError: event.payload.is_error,
          at: event.createdAt,
        };
        break;
      }
      default:
        items.push({ type: "event", key: `event:${event.id}`, event });
    }
  }
  return items;
}

export function toolStepStatus(step: ToolStep, runFinished: boolean): { label: string; tone: Tone } {
  if (step.result) {
    return step.result.isError ? { label: "Error", tone: "red" } : { label: "Done", tone: "green" };
  }
  if (step.approval?.state === "denied") return { label: "Denied", tone: "red" };
  if (step.approval?.state === "requested") {
    return runFinished
      ? { label: "Not decided", tone: "neutral" }
      : { label: "Awaiting approval", tone: "amber" };
  }
  return runFinished ? { label: "No result", tone: "neutral" } : { label: "Running", tone: "blue" };
}

// ---------------------------------------------------------------------------------------------
// Merging live changes
// ---------------------------------------------------------------------------------------------

// Events are append-only, so a row already held is never replaced. Returns the same array when
// nothing is new, which lets React skip the render.
export function mergeEvents<T extends { id: number }>(
  current: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const seen = new Set(current.map((row) => row.id));
  const added = incoming.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.id - b.id);
}

export function upsertById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------
// Run-level helpers
// ---------------------------------------------------------------------------------------------

export const RUN_PREVIEW_LENGTH = 120;

export function summarizeRun(
  run: Pick<RunRow, "id" | "created_at" | "status" | "model" | "task">,
): RunSummary {
  return {
    id: run.id,
    created_at: run.created_at,
    status: run.status,
    model: run.model,
    preview: truncate(run.task, RUN_PREVIEW_LENGTH),
  };
}

// Newest first, capped. A changed run replaces its old entry; a new one is added.
export function mergeRunList(
  current: readonly RunSummary[],
  incoming: readonly RunSummary[],
  limit: number,
): RunSummary[] {
  return upsertById(current, incoming)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
}

export function pendingApprovals<T extends ApprovalLike>(approvals: readonly T[]): T[] {
  return approvals.filter((approval) => approval.status === "pending");
}

// A run in one of these states is waiting for the agent and nothing will call it by itself:
// the first "advance" never reached the agent, or the one after the last decision did not.
export function canRetry(status: string, approvals: readonly ApprovalLike[]): boolean {
  if (status === "queued") return true;
  return status === "awaiting_approval" && pendingApprovals(approvals).length === 0;
}

// The agent refreshes `updated_at` every 10 s while it works and treats 60 s of silence as a dead
// run. The page waits longer than that before saying so, so that when someone clicks, the agent
// agrees. Browser and database clocks differ by seconds, not by this much.
export const STALLED_AFTER_MS = 90_000;

// A run still marked running whose agent has gone quiet: the function was killed or crashed.
export function isStalled(status: string, updatedAtIso: string, nowMs: number): boolean {
  if (status !== "running") return false;
  const updatedAt = Date.parse(updatedAtIso);
  return Number.isFinite(updatedAt) && nowMs - updatedAt > STALLED_AFTER_MS;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// `runs.usage` may be `{}` (the run has not finished, or the provider reports nothing).
export function formatUsage(usage: unknown): string[] {
  if (!isRecord(usage)) return [];
  const parts: string[] = [];
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input !== null && output !== null) {
    parts.push(`${input.toLocaleString("en-US")} in / ${output.toLocaleString("en-US")} out tokens`);
  } else if (input !== null) {
    parts.push(plural(input, "input token", "input tokens"));
  } else if (output !== null) {
    parts.push(plural(output, "output token", "output tokens"));
  }
  const requests = count(usage.requests);
  if (requests !== null) parts.push(plural(requests, "request", "requests"));
  const toolCalls = count(usage.tool_calls);
  if (toolCalls !== null) parts.push(plural(toolCalls, "tool call", "tool calls"));
  const cost = count(usage.cost_usd);
  if (cost !== null) parts.push(formatCost(cost));
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Time. `now` and the reference point are arguments so the output does not depend on the clock
// or on the time zone, which keeps server and browser renders identical.
// ---------------------------------------------------------------------------------------------

export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} d ago`;
  return iso.slice(0, 10);
}

export function formatUtc(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Time since the run started, e.g. "+3.2s", "+1m 05s", "+2h 07m".
export function formatElapsed(startIso: string, atIso: string): string {
  const ms = Date.parse(atIso) - Date.parse(startIso);
  if (Number.isNaN(ms)) return "";
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `+${total.toFixed(1)}s`;
  const seconds = Math.floor(total);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 3600) return `+${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `+${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}
