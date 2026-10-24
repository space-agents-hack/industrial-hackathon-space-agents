import "server-only";

import { after } from "next/server";

import { type IndexSlice, parseIndexStream } from "@/lib/regulation-index";

// `status` is the agent's HTTP status, or null when no response arrived at all.
const AGENT_ANSWER_TIMEOUT_MS = 30_000;

export class AgentError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
    this.status = status;
  }
}

export class AgentConfigError extends Error {
  constructor() {
    super("AGENT_URL and AGENT_SHARED_SECRET must both be set on the web server (see web/.env.example).");
    this.name = "AgentConfigError";
  }
}

// Asks the agent service to work on a run. Resolves as soon as the agent has accepted the
// request; the work itself is reported through the database, not through this call.
export async function advanceRun(runId: string): Promise<void> {
  await startOnAgent(`/runs/${encodeURIComponent(runId)}/advance`, `advanceRun(${runId})`);
}

// The same for one slice of a regulation import (agent/agent_service/domain/regulations.py). The
// agent leaves an import `paused` when its slice of time runs out; the import page calls this again.
export async function advanceRegulationImport(importId: string): Promise<void> {
  await startOnAgent(
    `/regulations/imports/${encodeURIComponent(importId)}/advance`,
    `advanceRegulationImport(${importId})`,
  );
}

// One slice of indexing an organisation's library for search: vectors, then scope summaries
// (agent domain/regulation_search.py). Unlike a run, the answer is the result: the slice keeps no
// row of its own, so the web waits for the agent's last line and the page decides whether to send
// the next slice. The agent stops a slice after index_slice_s (150 s); the route allows 300 s.
const INDEX_SLICE_TIMEOUT_MS = 280_000;

export async function advanceIndex(organizationId: string): Promise<IndexSlice> {
  const baseUrl = process.env.AGENT_URL;
  const secret = process.env.AGENT_SHARED_SECRET;
  if (!baseUrl || !secret) throw new AgentConfigError();
  const url = `${baseUrl.replace(/\/+$/, "")}/regulations/index/${encodeURIComponent(organizationId)}/advance`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(INDEX_SLICE_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new AgentError("The agent could not be reached.", null, { cause });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AgentError(`The agent answered ${response.status}.`, response.status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new AgentError("The connection to the agent dropped before the slice ended.", null, { cause });
  }
  const slice = parseIndexStream(text);
  if (!slice) throw new AgentError("The agent ended the slice without saying what it did.", null);
  return slice;
}

// Parses a case's pending files once (agent_service/domain/case_ingest.py). Like a run, the agent
// answers at once and the parsing is reported through case_files.status.
export async function ingestCase(caseId: string): Promise<void> {
  await startOnAgent(`/cases/${encodeURIComponent(caseId)}/ingest`, `ingestCase(${caseId})`);
}

async function startOnAgent(path: string, label: string): Promise<void> {
  const baseUrl = process.env.AGENT_URL;
  const secret = process.env.AGENT_SHARED_SECRET;
  if (!baseUrl || !secret) throw new AgentConfigError();

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  // A bound on the wait for the agent's first line only. Once it has answered, the run may last
  // as long as the function does; before that, a hung agent would keep the person's click
  // spinning for minutes with no message.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_ANSWER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (cause) {
    throw new AgentError("The agent could not be reached.", null, { cause });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AgentError(`The agent answered ${response.status}.`, response.status);
  }

  // The agent does the whole run inside this request and there is no documented `waitUntil` for
  // Python on Vercel, so it cannot be trusted to keep working once its caller hangs up. The web
  // therefore holds the connection: our own response has already gone out, and after() keeps
  // reading the agent's stream (accepted, heartbeats, done) until the agent closes it.
  const body = response.body;
  after(async () => {
    if (!body) return;
    try {
      const reader = body.getReader();
      let done = false;
      while (!done) ({ done } = await reader.read());
    } catch (error) {
      console.error(`${label}: the connection to the agent dropped before the work ended`, error);
    }
  });
}

// What to tell the person at the keyboard. Never includes the URL or the secret.
export function describeAgentFailure(error: unknown, subject: "run" | "import" | "case" | "library" = "run"): string {
  if (error instanceof AgentConfigError) {
    return "The agent is not configured on the web server (AGENT_URL / AGENT_SHARED_SECRET).";
  }
  if (error instanceof AgentError) {
    switch (error.status) {
      case null:
        return "The agent could not be reached.";
      case 401:
        return "The agent rejected the shared secret.";
      case 404:
        return `The agent does not know this ${subject}.`;
      case 409:
        return `The agent says this ${subject} cannot advance right now. It may already be running.`;
      default:
        return `The agent answered with an error (${error.status}).`;
    }
  }
  return "The agent call failed.";
}

// The status our own route handler should answer with when the agent call fails.
export function agentFailureStatus(error: unknown): number {
  if (error instanceof AgentConfigError) return 500;
  if (error instanceof AgentError && (error.status === 404 || error.status === 409)) {
    return error.status;
  }
  return 502;
}
