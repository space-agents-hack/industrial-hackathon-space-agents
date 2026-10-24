// Pure helpers for the admin area: providers and models, settings, request bodies, the audit
// log's summaries and the database's refusals. No React, Supabase or Next.js imports, so
// `node --test` runs them directly; relative imports carry `.ts` for the same reason.

import { type MemberStatus, type Role, ROLE_LABELS, isMemberStatus, isRole } from "./access.ts";
import { compactJson } from "./trace.ts";
import { type Parsed, isUuid } from "./validation.ts";

// The same rule as scripts/create-user.sh enforces for a hosted project (contract.test.ts).
export const MIN_PASSWORD_LENGTH = 12;

// ---------------------------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------------------------

// The five the database accepts (provider_connections.provider check). Order is the page's.
export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "ollama", label: "Ollama" },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]["id"];

// Configured with the URL of a server the organisation runs (SYS-30), not with a key.
export const ENDPOINT_PROVIDERS = ["ollama"] as const;
export type EndpointProviderId = (typeof ENDPOINT_PROVIDERS)[number];
export type KeyProviderId = Exclude<ProviderId, EndpointProviderId>;

export function isEndpointProvider(value: unknown): value is EndpointProviderId {
  return ENDPOINT_PROVIDERS.some((p) => p === value);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.some((p) => p.id === value);
}

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// What the model picker offers: the scripted model (no provider, no network, always there) and
// the five providers.
export type ModelSource = "scripted" | ProviderId;
export const SCRIPTED_MODEL = "scripted";

export function isModelSource(value: unknown): value is ModelSource {
  return value === SCRIPTED_MODEL || isProviderId(value);
}

// OpenRouter publishes its catalogue; the others list models only to a caller with a key (or,
// for Ollama, once its server is connected).
export function listNeedsKey(source: ModelSource): boolean {
  return source !== SCRIPTED_MODEL && source !== "openrouter";
}

// Model ids are "<prefix>:<model>" as the agent library reads them (agent/agent_service/
// settings.py). OpenAI has three prefixes for its two APIs; they all bill the same key.
const PREFIXES: Record<string, ProviderId> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-chat": "openai",
  "openai-responses": "openai",
  openrouter: "openrouter",
  deepseek: "deepseek",
  ollama: "ollama",
};

// Which picker a stored model belongs to. Null for an empty value (the default applies) and for
// anything this build does not recognise, which the page then shows as text instead of losing.
export function modelSourceOf(model: string | null | undefined): ModelSource | null {
  if (!model) return null;
  if (model === SCRIPTED_MODEL) return SCRIPTED_MODEL;
  const colon = model.indexOf(":");
  if (colon <= 0) return null;
  return PREFIXES[model.slice(0, colon)] ?? null;
}

export type ModelOption = {
  id: string;
  label: string;
  promptUsdPerMtok: number | null;
  completionUsdPerMtok: number | null;
};

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// The agent's `GET /providers/models` body. Entries without a usable id are dropped.
export function parseModelList(body: unknown): ModelOption[] {
  if (!isRecord(body) || !Array.isArray(body.models)) return [];
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const raw of body.models) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.includes(":") || seen.has(raw.id)) continue;
    seen.add(raw.id);
    models.push({
      id: raw.id,
      label: typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : modelName(raw.id),
      promptUsdPerMtok: price(raw.prompt_usd_per_mtok),
      completionUsdPerMtok: price(raw.completion_usd_per_mtok),
    });
  }
  return models;
}

// "openrouter:anthropic/claude-opus-5-5" → "anthropic/claude-opus-5-5".
export function modelName(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(colon + 1) : id;
}

// Per million tokens. Small prices keep their significant digits ($0.075, not $0.08), because
// the difference between two cheap models is exactly what someone choosing one wants to see.
export function formatUsdPerMtok(usd: number): string {
  if (usd === 0) return "free";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const fixed = usd.toFixed(4).replace(/0+$/, "");
  const decimals = fixed.split(".")[1]?.length ?? 0;
  return decimals < 2 ? `$${usd.toFixed(2)}` : `$${fixed}`;
}

export function formatModelPrice(option: Pick<ModelOption, "promptUsdPerMtok" | "completionUsdPerMtok">): string {
  const { promptUsdPerMtok: input, completionUsdPerMtok: output } = option;
  if (input === null || output === null) return "price not published";
  if (input === 0 && output === 0) return "free";
  return `${formatUsdPerMtok(input)} in / ${formatUsdPerMtok(output)} out per M tokens`;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

// The same bounds as the organization_settings checks, so the form says no before the database.
export const MAX_MODEL_REQUESTS_LIMIT = 200;
// numeric(12, 2): ten digits before the point.
export const COST_CAP_LIMIT = 9_999_999_999.99;

export type SettingsInput = {
  org: string;
  model: string | null;
  maxModelRequests: number | null;
  monthlyCostCapUsd: number | null;
};

// An empty field means "use the default" and is stored as null, never as 0: a cap of $0 would
// refuse every run.
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
}

export function parseSettings(body: unknown): Parsed<SettingsInput> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  const rawModel = body.model;
  if (rawModel !== null && rawModel !== undefined && typeof rawModel !== "string") {
    return { ok: false, error: "The model must be text." };
  }
  const model = typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : null;
  if (model !== null && (model.length > 200 || /\s/.test(model))) {
    return { ok: false, error: "That is not a model id." };
  }
  const requests = optionalNumber(body.max_model_requests);
  if (
    requests === undefined ||
    (requests !== null && (!Number.isInteger(requests) || requests < 1 || requests > MAX_MODEL_REQUESTS_LIMIT))
  ) {
    return {
      ok: false,
      error: `Max model requests per run must be a whole number from 1 to ${MAX_MODEL_REQUESTS_LIMIT}, or empty.`,
    };
  }
  const cap = optionalNumber(body.monthly_cost_cap_usd);
  if (cap === undefined || (cap !== null && (cap < 0 || cap > COST_CAP_LIMIT))) {
    return { ok: false, error: "The monthly cost cap must be an amount in USD, or empty." };
  }
  return {
    ok: true,
    value: {
      org: body.org,
      model,
      maxModelRequests: requests,
      monthlyCostCapUsd: cap === null ? null : Math.round(cap * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Request bodies of the admin routes
// ---------------------------------------------------------------------------------------------

// Supabase Auth hashes with bcrypt, which ignores everything after 72 bytes: a longer password
// would be accepted and then work with only its first part.
export const MAX_PASSWORD_BYTES = 72;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPassword(password: unknown): string | null {
  if (typeof password !== "string") return "Enter a password.";
  if (Array.from(password).length < MIN_PASSWORD_LENGTH) {
    return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `The password is longer than ${MAX_PASSWORD_BYTES} bytes.`;
  }
  return null;
}

// Deliberately loose: Supabase Auth is the judge of what an email is. This only catches typing
// a name into the email field.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOrgOnly(body: unknown): Parsed<{ org: string }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  return { ok: true, value: { org: body.org } };
}

export function parseProviderKey(
  body: unknown,
): Parsed<{ org: string; provider: KeyProviderId; apiKey: string }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isProviderId(body.provider)) return { ok: false, error: "Unknown provider." };
  if (isEndpointProvider(body.provider)) return { ok: false, error: "Connect this provider with its server URL." };
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  // The same rule as set_provider_key, checked first so the agent is not asked about a typo.
  if (apiKey.length < 16 || /\s/.test(apiKey) || apiKey.length > 1000) {
    return { ok: false, error: "That does not look like an API key." };
  }
  return { ok: true, value: { org: body.org, provider: body.provider, apiKey } };
}

export type AuthScheme = "none" | "bearer" | "basic";
export const AUTH_SCHEMES: { id: AuthScheme; label: string }[] = [
  { id: "none", label: "None" },
  { id: "bearer", label: "Bearer token" },
  { id: "basic", label: "User name and password" },
];

export function isAuthScheme(value: unknown): value is AuthScheme {
  return AUTH_SCHEMES.some((a) => a.id === value);
}

export function authSchemeLabel(id: string | null | undefined): string {
  return AUTH_SCHEMES.find((a) => a.id === id)?.label ?? id ?? "?";
}

export type EndpointInput = {
  org: string;
  provider: EndpointProviderId;
  baseUrl: string;
  authScheme: AuthScheme;
  username: string | null;
  // Null keeps the stored one: moving the server to another port should not mean typing the
  // token again (set_provider_endpoint does the same).
  secret: string | null;
};

// The same rule as private.valid_endpoint_url, checked first so the agent is not asked about a
// typo. No user:password@ in the URL: that would put a secret where every member can read it.
const ENDPOINT_URL = /^https?:\/\/[^/@\s?#]+(\/[^\s?#@]*)?$/;

export function parseProviderEndpoint(body: unknown): Parsed<EndpointInput> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isEndpointProvider(body.provider)) return { ok: false, error: "Unknown provider." };
  const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
  if (baseUrl === "") return { ok: false, error: "Enter the server URL, for example http://localhost:11434." };
  if (/^https?:\/\/[^/]*@/.test(baseUrl)) {
    return { ok: false, error: "Put the user name and password in their own fields, not in the URL." };
  }
  if (!ENDPOINT_URL.test(baseUrl) || baseUrl.length > 500) {
    return { ok: false, error: "The server URL must start with http:// or https:// and have no query." };
  }
  const authScheme = body.auth_scheme;
  if (!isAuthScheme(authScheme)) {
    return { ok: false, error: "Choose how the server checks who is calling." };
  }
  const username = typeof body.username === "string" && body.username.trim() !== "" ? body.username.trim() : null;
  if (authScheme === "basic" && (username === null || /[:\s]/.test(username) || username.length > 200)) {
    return { ok: false, error: "Enter a user name without colons or spaces." };
  }
  const secret = typeof body.secret === "string" && body.secret !== "" ? body.secret : null;
  if (secret !== null && (secret.length > 1000 || /[\r\n]/.test(secret))) {
    return { ok: false, error: "That does not look like a token or password." };
  }
  return {
    ok: true,
    value: {
      org: body.org,
      provider: body.provider,
      baseUrl,
      authScheme,
      username: authScheme === "basic" ? username : null,
      secret: authScheme === "none" ? null : secret,
    },
  };
}

export function parseProviderDelete(body: unknown): Parsed<{ org: string; provider: ProviderId }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isProviderId(body.provider)) return { ok: false, error: "Unknown provider." };
  return { ok: true, value: { org: body.org, provider: body.provider } };
}

// The password is optional: an email that already has an account is added with it, and only an
// email with no account needs one (the route then creates the account through the agent). Null
// means none was typed; a short one typed is still refused, so a half-typed password is not
// silently dropped.
export function parseAddPerson(
  body: unknown,
): Parsed<{ org: string; email: string; role: Role; password: string | null }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  const email = parseEmail(body.email);
  if (!email) return { ok: false, error: "Enter a valid email." };
  if (!isRole(body.role)) return { ok: false, error: "Choose a role." };
  if (body.password === undefined || body.password === null || body.password === "") {
    return { ok: true, value: { org: body.org, email, role: body.role, password: null } };
  }
  const passwordError = checkPassword(body.password);
  if (passwordError) return { ok: false, error: passwordError };
  return { ok: true, value: { org: body.org, email, role: body.role, password: body.password as string } };
}

function parseEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL.test(email) && email.length <= 320 ? email : null;
}

export function parseRemoveMember(body: unknown): Parsed<{ org: string; userId: string }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isUuid(body.user_id)) return { ok: false, error: "Unknown person." };
  return { ok: true, value: { org: body.org, userId: body.user_id } };
}

export function parseSetMember(
  body: unknown,
): Parsed<{ org: string; userId: string; role: Role; status: MemberStatus }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isUuid(body.user_id)) return { ok: false, error: "Unknown person." };
  if (!isRole(body.role)) return { ok: false, error: "Unknown role." };
  if (!isMemberStatus(body.status)) return { ok: false, error: "Unknown status." };
  return { ok: true, value: { org: body.org, userId: body.user_id, role: body.role, status: body.status } };
}

export function parseSetPassword(
  body: unknown,
): Parsed<{ org: string; userId: string; password: string }> {
  if (!isRecord(body) || !isUuid(body.org)) return { ok: false, error: "Unknown organisation." };
  if (!isUuid(body.user_id)) return { ok: false, error: "Unknown person." };
  const passwordError = checkPassword(body.password);
  if (passwordError) return { ok: false, error: passwordError };
  return { ok: true, value: { org: body.org, userId: body.user_id, password: body.password as string } };
}

export function parseOrganizationName(body: unknown): Parsed<{ name: string }> {
  const name = isRecord(body) && typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return { ok: false, error: "Enter a name." };
  if (Array.from(name).length > 200) return { ok: false, error: "The name is longer than 200 characters." };
  return { ok: true, value: { name } };
}

// A new organisation and, optionally, the existing account that becomes its first admin. An
// empty admin email creates it with nobody in it.
export function parseCreateOrganization(body: unknown): Parsed<{ name: string; adminEmail: string | null }> {
  const named = parseOrganizationName(body);
  if (!named.ok) return named;
  const raw = isRecord(body) && typeof body.admin_email === "string" ? body.admin_email.trim() : "";
  if (raw === "") return { ok: true, value: { name: named.value.name, adminEmail: null } };
  const adminEmail = parseEmail(raw);
  if (!adminEmail) return { ok: false, error: "Enter a valid email for the first admin, or leave it empty." };
  return { ok: true, value: { name: named.value.name, adminEmail } };
}

// For "Generate" in the add-person form. No 0/O, 1/l/I: the password is read aloud or copied by
// hand more often than one would hope. 16 characters from 55 symbols is about 92 bits.
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 16): string {
  // Rejection sampling: a plain `byte % 55` would make the first symbols slightly likelier.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The database's refusals
// ---------------------------------------------------------------------------------------------

// The platform functions raise these codes with a sentence meant for a person ("this would
// leave the organisation without an admin"); those are shown as they are. Anything else is a
// fault, logged on the server, and the person gets the fallback.
const PLAIN_CODES: Record<string, number> = {
  "42501": 403, // insufficient_privilege: "only an admin of this organisation ..."
  "23514": 409, // check_violation: the last-admin rule
  "22023": 400, // invalid_parameter_value: "that does not look like an API key"
  "55000": 409, // object_not_in_prerequisite_state: "another import is still in progress"
  "P0002": 404, // no_data_found: "no account has the email ...", "that person is not in this organisation"
};

export type DbError = { code?: string | null; message?: string | null };

export function describeDbError(error: DbError, fallback: string): { message: string; status: number } {
  const status = error.code ? PLAIN_CODES[error.code] : undefined;
  // A table's own check constraint raises 23514 too, worded for a developer ('new row for
  // relation "organization_settings" violates check constraint ...'). Only the functions'
  // sentences are passed on.
  const technical = /\b(relation|constraint)\s+"/.test(error.message ?? "");
  if (status && technical) return { message: "The database refused that value.", status: 400 };
  if (status && error.message) {
    const text = error.message.trim();
    return { message: text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : "."), status };
  }
  if (error.code === "23503") return { message: "That person or organisation no longer exists.", status: 404 };
  return { message: fallback, status: 500 };
}

// ---------------------------------------------------------------------------------------------
// Usage and money
// ---------------------------------------------------------------------------------------------

export function formatUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "2026-10-01" → "October 2026". Read as UTC so the month does not shift with the time zone.
export function formatMonth(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Share of the cap spent, for the current month's line. Null when there is no cap.
export function capShare(costUsd: number, capUsd: number | null): string | null {
  if (capUsd === null) return null;
  if (capUsd === 0) return costUsd > 0 ? "over the cap" : "cap is $0";
  return `${Math.round((costUsd / capUsd) * 100)}% of the cap`;
}

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  pasted: "pasted",
  openrouter_oauth: "OpenRouter login",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

// One readable line per audit row. `nameOf` turns a user id into an email where the page knows
// it. An action this build does not know is shown with its raw detail, never hidden.
export function summarizeAuditEvent(
  event: { action: string; detail: unknown },
  nameOf: (userId: string) => string,
): string {
  const detail = isRecord(event.detail) ? event.detail : {};
  switch (event.action) {
    case "organization.created":
      return `Created the organisation "${text(detail.name) ?? "?"}".`;
    case "settings.updated": {
      const model = text(detail.model);
      const requests = num(detail.max_model_requests);
      const cap = num(detail.monthly_cost_cap_usd);
      return [
        `Settings: model ${model ?? "default"}`,
        `max model requests per run ${requests ?? "default"}`,
        `monthly cap ${cap === null ? "default" : formatUsd(cap)}.`,
      ].join(", ");
    }
    case "provider.connected":
    case "provider.rotated": {
      const baseUrl = text(detail.base_url);
      if (baseUrl) {
        const verb = event.action === "provider.connected" ? "Connected" : "Changed";
        const last4 = text(detail.last4);
        return `${verb} the ${providerLabel(text(detail.provider) ?? "?")} server ${baseUrl} (authentication: ${authSchemeLabel(
          text(detail.auth_scheme),
        ).toLowerCase()}${last4 ? `, token ending ${last4}` : ""}).`;
      }
      const verb = event.action === "provider.connected" ? "Connected" : "Replaced the key of";
      const source = text(detail.source);
      return `${verb} ${providerLabel(text(detail.provider) ?? "?")} (key ending ${text(detail.last4) ?? "?"}${
        source ? `, ${sourceLabel(source)}` : ""
      }).`;
    }
    case "provider.deleted":
      return isEndpointProvider(detail.provider)
        ? `Disconnected the ${providerLabel(detail.provider)} server.`
        : `Removed the ${providerLabel(text(detail.provider) ?? "?")} key.`;
    case "member.set": {
      const userId = text(detail.user_id);
      const role = text(detail.role);
      const status = text(detail.status);
      const roleText = role && isRole(role) ? ROLE_LABELS[role].toLowerCase() : (role ?? "?");
      return `${userId ? nameOf(userId) : "Someone"}: ${roleText}, ${status ?? "?"}.`;
    }
    case "member.removed": {
      // The email is in the row because a removed person is no longer among the members the
      // page names people from.
      const userId = text(detail.user_id);
      const who = text(detail.email) ?? (userId ? nameOf(userId) : "Someone");
      return `Removed ${who} from the organisation.`;
    }
    default:
      return `${event.action} ${compactJson(event.detail, 160)}`;
  }
}

// For an id with no known email: short enough to read, long enough to tell two apart.
export function shortId(id: string): string {
  return `user ${id.slice(0, 8)}`;
}
