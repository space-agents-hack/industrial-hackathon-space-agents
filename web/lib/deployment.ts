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
  { name: "GH_CONTROL_TOKEN", label: "GitHub control token", hint: "the token this page uses; reaches the app with the release" },
  { name: "SUPABASE_ACCESS_TOKEN", label: "Supabase access token", hint: "only for the Bootstrap workflow; releases do not use it" },
] as const;

export type SecretName = (typeof EDITABLE_SECRETS)[number]["name"];

// What the Bootstrap workflow refuses to run without (bootstrap.yml, "What is set").
export const BOOTSTRAP_SECRETS: SecretName[] = ["VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "GH_CONTROL_TOKEN"];

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
    if (name === "GH_CONTROL_TOKEN" && !value.startsWith("github_pat_")) {
      return { ok: false, error: "The GitHub control token is a fine-grained token; it starts with github_pat_." };
    }
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

// GitHub's form for the control token, filled in. The person picks the repository; GitHub does
// not allow filling that in. Administration is left out on purpose: with it the token could
// delete the repository. Its one use (restricting production to main) is a click instead.
export function controlTokenUrl(repo: string, appName: string): string {
  const url = new URL("https://github.com/settings/personal-access-tokens/new");
  url.searchParams.set("name", `${appName} control`);
  url.searchParams.set("description", "Lets the app change its deployment settings and start releases.");
  const owner = repo.split("/")[0];
  if (owner) url.searchParams.set("target_name", owner);
  url.searchParams.set("expires_in", "366");
  url.searchParams.set("actions", "write");
  url.searchParams.set("environments", "write");
  url.searchParams.set("secrets", "write");
  url.searchParams.set("variables", "write");
  return url.toString();
}

export const CONTROL_TOKEN_PERMISSIONS = "Actions, Environments, Secrets and Variables: read and write";
