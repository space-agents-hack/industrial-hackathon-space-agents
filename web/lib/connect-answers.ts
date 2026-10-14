// The form on the Setup page, checked before anything runs. The result is the JSON that
// `scripts/bootstrap.sh --from-json` reads; its keys must match the ones the script asks for.

export type ConnectUser = { email: string; password: string };

export type ConnectAnswers = {
  name?: string;
  agent_domain?: string;
  // Only needed while a project has more than one secret key (during a rotation).
  secret_key?: string;
  vercel_token: string;
  project_ref: string;
  db_password: string;
  supabase_token: string;
  apply_migrations: "y" | "n";
  agent_model: string;
  provider_key?: string;
  // Optional: a read-only GitHub token so Admin › Releases works in production (lib/github.ts).
  releases_token?: string;
  users: ConnectUser[];
  // Set by the server, never by the form: see app/api/setup/connect/route.ts.
  shared_secret?: string;
};

export type Parsed = { ok: true; value: ConnectAnswers } | { ok: false; error: string };

// The same rule as scripts/create-user.sh enforces for a hosted project.
export const MIN_PASSWORD_LENGTH = 12;

const KNOWN_PROVIDERS = ["anthropic:", "openai:", "openai-chat:", "openai-responses:", "openrouter:", "deepseek:"];

export function needsProviderKey(model: string): boolean {
  return KNOWN_PROVIDERS.some((prefix) => model.startsWith(prefix));
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

export function parseConnectAnswers(input: unknown): Parsed {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const body = input as Record<string, unknown>;

  const project_ref = text(body, "project_ref");
  // A reference is the 20-character subdomain of the project's URL.
  if (!/^[a-z0-9]{20}$/.test(project_ref)) {
    return { ok: false, error: "The Project ID is 20 lowercase letters, from Settings, General." };
  }
  for (const [key, label] of [
    ["db_password", "the database password"],
    ["supabase_token", "the Supabase access token"],
    ["vercel_token", "the Vercel token"],
  ] as const) {
    if (!text(body, key)) return { ok: false, error: `Missing ${label}.` };
  }

  // These two end up in shell commands and URLs. Quoting keeps them safe; this keeps them sane.
  const name = text(body, "name");
  if (name && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) {
    return { ok: false, error: "Project names use lowercase letters, digits and dashes." };
  }
  const agent_domain = text(body, "agent_domain");
  if (agent_domain && !/^[a-z0-9.-]{3,253}$/.test(agent_domain)) {
    return { ok: false, error: "The agent domain looks wrong; leave it empty to use the one Vercel assigns." };
  }

  const secret_key = text(body, "secret_key");
  if (secret_key && !secret_key.startsWith("sb_secret_")) {
    return { ok: false, error: "A Supabase secret key starts with sb_secret_." };
  }

  const agent_model = text(body, "agent_model") || "scripted";
  const provider_key = text(body, "provider_key");
  if (needsProviderKey(agent_model) && !provider_key) {
    return { ok: false, error: `The model ${agent_model} needs its provider's API key.` };
  }

  const releases_token = text(body, "releases_token");
  if (releases_token && !releases_token.startsWith("github_pat_")) {
    return { ok: false, error: "The releases token is a fine-grained GitHub token; it starts with github_pat_." };
  }

  const rawUsers = Array.isArray(body.users) ? body.users : [];
  const users: ConnectUser[] = [];
  for (const raw of rawUsers.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const email = text(entry, "email").toLowerCase();
    const password = typeof entry.password === "string" ? entry.password : "";
    if (!email && !password) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: `Not an email address: ${email || "(empty)"}.` };
    }
    if (password.length < MIN_PASSWORD_LENGTH || /[\t\n]/.test(password)) {
      return {
        ok: false,
        error: `The password for ${email} needs at least ${MIN_PASSWORD_LENGTH} characters, on one line.`,
      };
    }
    users.push({ email, password });
  }

  return {
    ok: true,
    value: {
      ...(name ? { name } : {}),
      ...(agent_domain ? { agent_domain } : {}),
      ...(secret_key ? { secret_key } : {}),
      vercel_token: text(body, "vercel_token"),
      project_ref,
      db_password: typeof body.db_password === "string" ? body.db_password : "",
      supabase_token: text(body, "supabase_token"),
      apply_migrations: body.apply_migrations === false ? "n" : "y",
      agent_model,
      ...(provider_key ? { provider_key } : {}),
      ...(releases_token ? { releases_token } : {}),
      users,
    },
  };
}
