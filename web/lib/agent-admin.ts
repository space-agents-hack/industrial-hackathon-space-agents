import "server-only";

import { type ModelOption, type ProviderId, parseModelList } from "@/lib/admin";
import { type CheckResult, parseCheckResult } from "@/lib/certivity";
import {
  type ChangesRequest,
  type ChangesResult,
  type SubgoalCase,
  parseChangesResult,
  parseSubgoalCases,
} from "@/lib/changes";

// The agent service's admin endpoints. The agent holds the Supabase secret key and the provider
// keys; the web holds neither, so creating a person, setting a password, testing a key and
// listing a provider's models all go through here. Every call is server to server with the
// shared secret, exactly like lib/agent.ts; the browser never reaches the agent.
//
// Each call is short (a database write or one request to a provider), so one timeout covers
// the whole exchange. A provider that takes longer than this to answer a key check is treated as
// unreachable rather than keeping the admin's click spinning.
const ADMIN_CALL_TIMEOUT_MS = 15_000;

export class AgentAdminError extends Error {
  readonly status: number | null;
  // A sentence for the person at the keyboard. Never contains the URL, the secret or a key.
  readonly userMessage: string;

  constructor(userMessage: string, status: number | null, options?: ErrorOptions) {
    super(userMessage, options);
    this.name = "AgentAdminError";
    this.status = status;
    this.userMessage = userMessage;
  }
}

type CallOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  // What a given status means for this endpoint, in words.
  messages?: Record<number, string>;
  timeoutMs?: number;
};

async function call(path: string, options: CallOptions = {}): Promise<unknown> {
  const baseUrl = process.env.AGENT_URL;
  const secret = process.env.AGENT_SHARED_SECRET;
  if (!baseUrl || !secret) {
    throw new AgentAdminError(
      "The agent is not configured on the web server (AGENT_URL / AGENT_SHARED_SECRET).",
      null,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? ADMIN_CALL_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new AgentAdminError(
      timedOut ? "The agent did not answer in time." : "The agent could not be reached.",
      null,
      { cause },
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // The agent words its refusals for people ("No anthropic key is connected for this
    // organisation.", "… rejected the stored key. Replace it in Admin, Providers."), so a string
    // `detail` is passed on. Its 422 for a malformed request is a list and never echoes the input.
    const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : null;
    const message =
      response.status === 401
        ? "The agent rejected the shared secret."
        : (detail ??
          options.messages?.[response.status] ??
          (response.status === 404
            ? "This version of the agent does not offer that yet. Deploy the agent again."
            : `The agent answered with an error (${response.status}).`));
    throw new AgentAdminError(message, response.status);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Creates a confirmed user, or returns the id of the one that already has this email without
// touching their password. `created` says which happened.
export async function createAuthUser(
  email: string,
  password: string,
): Promise<{ userId: string; created: boolean }> {
  const body = await call("/admin/users", {
    method: "POST",
    body: { email, password },
    messages: {
      400: "The account could not be created: the email or the password was refused.",
      422: "The account could not be created: the email or the password was refused.",
    },
  });
  if (!isRecord(body) || typeof body.user_id !== "string") {
    throw new AgentAdminError("The agent answered without a user id.", 200);
  }
  return { userId: body.user_id, created: body.created === true };
}

export async function setAuthPassword(userId: string, password: string): Promise<void> {
  await call("/admin/users/password", {
    method: "POST",
    body: { user_id: userId, password },
    messages: {
      404: "That account no longer exists.",
      400: "The password was refused.",
      422: "The password was refused.",
    },
  });
}

// One cheap request to the provider with this key. `ok: false` means the provider said no; an
// exception means the question could not be asked.
export async function checkProviderKey(
  provider: ProviderId,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const body = await call("/providers/check", { method: "POST", body: { provider, api_key: apiKey } });
  if (!isRecord(body) || typeof body.ok !== "boolean") {
    throw new AgentAdminError("The agent answered the key check in an unexpected form.", 200);
  }
  return { ok: body.ok, detail: typeof body.detail === "string" ? body.detail : "" };
}

export async function listProviderModels(organizationId: string, provider: ProviderId): Promise<ModelOption[]> {
  const query = new URLSearchParams({ organization_id: organizationId, provider });
  const body = await call(`/providers/models?${query}`, {
    messages: { 409: "Connect a key for this provider first." },
  });
  return parseModelList(body);
}

export type AgentHealth = { model: string | null; version: string | null };

// The deployment's defaults, for "what applies when a field is empty". Never throws: a page
// that cannot reach the agent still renders, it just cannot name the default.
export async function agentHealth(): Promise<AgentHealth | null> {
  try {
    const body = await call("/health");
    if (!isRecord(body)) return null;
    return {
      model: typeof body.model === "string" ? body.model : null,
      version: typeof body.version === "string" ? body.version : null,
    };
  } catch {
    return null;
  }
}

// Certivity's validate.py and score_local.py, run by the agent on this text (a run's output or a
// file someone dropped). Not an admin action, but the same server-to-server call: the web cannot
// run Python, and the checks must be Certivity's own code to mean "accepted on upload".
export async function runCertivityChecks(text: string, organizationId: string | null): Promise<CheckResult> {
  const body = await call("/checks", {
    method: "POST",
    body: { text, organization_id: organizationId },
    messages: { 404: "This version of the agent cannot run Certivity's checks yet. Deploy the agent again." },
  });
  const result = parseCheckResult(body);
  if (!result) throw new AgentAdminError("The agent answered the checks in an unexpected form.", 200);
  return result;
}

// The sub-goal cases whose requirements_old.json is loaded (certivity_reference). Never throws:
// the page still works with an uploaded requirements file when the agent cannot list them.
export async function listSubgoalCases(): Promise<SubgoalCase[] | null> {
  try {
    return parseSubgoalCases(await call("/subgoal/cases"));
  } catch {
    return null;
  }
}

// Downloading two PDFs and extracting them takes a few seconds (about one per 200-page version,
// measured 2026-10-24); a minute leaves room for a slow bucket without holding the click forever.
const CHANGES_TIMEOUT_MS = 60_000;

export async function runSubgoalChanges(request: ChangesRequest): Promise<ChangesResult> {
  const body = await call("/subgoal/changes", {
    method: "POST",
    body: {
      organization_id: request.organizationId,
      old_version_id: request.oldVersionId,
      new_version_id: request.newVersionId,
      case_id: request.caseId,
      team_id: request.teamId,
      requirements_old: request.requirementsOld,
    },
    timeoutMs: CHANGES_TIMEOUT_MS,
    messages: { 404: "This version of the agent cannot compare versions yet. Deploy the agent again." },
  });
  const result = parseChangesResult(body);
  if (!result) throw new AgentAdminError("The agent answered in an unexpected form.", 200);
  return result;
}
