// Admin › Deployment: the values the workflows read from GitHub, which a platform admin changes
// from production (ADR-0005). Pure: what may be set and how it is checked. Talking to GitHub is
// in lib/github.ts.

// Secrets of the `production` environment that a person may replace. GitHub never gives a value
// back, so the page shows only when each was last changed. AGENT_SHARED_SECRET is not listed:
// it is renewed with a random value, never typed. The project IDs are written by setup; pointing
// production at another database is a new setup, not a settings change.
export const EDITABLE_SECRETS = [
  { name: "VERCEL_TOKEN", label: "Vercel token", hint: "vercel.com/account/tokens, scoped to the team" },
  { name: "SUPABASE_DB_PASSWORD", label: "Database password", hint: "after resetting it in Supabase, Database settings" },
  { name: "PROVIDER_API_KEY", label: "Default model's API key", hint: "for the model below; organisations can add their own in Providers" },
] as const;

export type SecretName = (typeof EDITABLE_SECRETS)[number]["name"];

// What a release needs from GitHub to deploy and to apply migrations (deploy.yml).
export const RELEASE_SECRETS = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_WEB_PROJECT_ID",
  "VERCEL_AGENT_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_DB_PASSWORD",
];

export const ENVIRONMENT = "production";

export type DeploymentChange = {
  secrets: Partial<Record<SecretName, string>>;
  agentModel: string | null;
  renewSharedSecret: boolean;
  apply: boolean;
  password: string;
};

type Parsed = { ok: true; value: DeploymentChange } | { ok: false; error: string };

const KNOWN_PROVIDERS = ["anthropic:", "openai:", "openai-chat:", "openai-responses:", "openrouter:", "deepseek:"];

export function needsProviderKey(model: string): boolean {
  return KNOWN_PROVIDERS.some((prefix) => model.startsWith(prefix));
}

// Empty fields mean "keep what is there": the form never shows a stored value, so it cannot send
// one back.
export function parseDeploymentChange(body: unknown): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const input = body as Record<string, unknown>;
  const rawSecrets = typeof input.secrets === "object" && input.secrets !== null ? (input.secrets as Record<string, unknown>) : {};

  const secrets: Partial<Record<SecretName, string>> = {};
  for (const { name, label } of EDITABLE_SECRETS) {
    const raw = rawSecrets[name];
    if (typeof raw !== "string" || raw === "") continue;
    // A password may contain spaces; a token or an ID never does.
    const value = name === "SUPABASE_DB_PASSWORD" ? raw : raw.trim();
    if (name !== "SUPABASE_DB_PASSWORD" && /\s/.test(value)) return { ok: false, error: `${label} has spaces in it.` };
    if (/[\n\r]/.test(value)) return { ok: false, error: `${label} must be on one line.` };
    secrets[name] = value;
  }

  const model = typeof input.agent_model === "string" ? input.agent_model.trim() : "";
  if (model && model !== "scripted" && !/^[a-z-]+:[\w./:-]+$/.test(model)) {
    return { ok: false, error: "A model is scripted or provider:name, for example anthropic:claude-opus-5-5." };
  }

  const password = typeof input.password === "string" ? input.password : "";
  if (!password) return { ok: false, error: "Enter your password to confirm." };

  const renewSharedSecret = input.renew_shared_secret === true;
  if (Object.keys(secrets).length === 0 && !model && !renewSharedSecret && input.apply !== true) {
    return { ok: false, error: "Nothing to change." };
  }

  return {
    ok: true,
    value: { secrets, agentModel: model || null, renewSharedSecret, apply: input.apply === true, password },
  };
}
