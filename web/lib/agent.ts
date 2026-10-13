import "server-only";

import { after } from "next/server";

// `status` is the agent's HTTP status, or null when no response arrived at all.
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
  const baseUrl = process.env.AGENT_URL;
  const secret = process.env.AGENT_SHARED_SECRET;
  if (!baseUrl || !secret) throw new AgentConfigError();

  const url = `${baseUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}/advance`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
  } catch (cause) {
    throw new AgentError("The agent could not be reached.", null, { cause });
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
      console.error(`advanceRun(${runId}): the connection to the agent dropped before the run ended`, error);
    }
  });
}

// What to tell the person at the keyboard. Never includes the URL or the secret.
export function describeAgentFailure(error: unknown): string {
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
        return "The agent does not know this run.";
      case 409:
        return "The agent says this run cannot advance right now. It may already be running.";
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
