// Request-body checks for the route handlers. Two endpoints do not justify a validation library.

export const TASK_MAX_LENGTH = 20000;
export const NOTE_MAX_LENGTH = 2000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Postgres `length()` counts characters, JavaScript `.length` counts UTF-16 units. Count the way
// the database does so a task it would accept is not rejected here.
function characters(text: string): number {
  return Array.from(text).length;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function parseNewRun(body: unknown): Parsed<{ task: string }> {
  if (!isRecord(body) || typeof body.task !== "string") {
    return { ok: false, error: 'Expected a JSON body like { "task": "..." }.' };
  }
  const task = body.task.trim();
  if (task === "") return { ok: false, error: "The task is empty." };
  if (characters(task) > TASK_MAX_LENGTH) {
    return { ok: false, error: `The task is longer than ${TASK_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { task } };
}

export type Decision = "approved" | "denied";

export function parseDecision(body: unknown): Parsed<{ decision: Decision; note: string | null }> {
  if (!isRecord(body) || (body.decision !== "approved" && body.decision !== "denied")) {
    return { ok: false, error: 'Expected a JSON body like { "decision": "approved" | "denied" }.' };
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return { ok: false, error: "The note must be text." };
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (characters(note) > NOTE_MAX_LENGTH) {
    return { ok: false, error: `The note is longer than ${NOTE_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { decision: body.decision, note: note === "" ? null : note } };
}
