// The "Create production" form on the local Setup page, checked before anything runs. The result
// is the JSON scripts/bootstrap.sh --from-json reads; contract.test.ts holds the two to the same
// keys.

import { MIN_PASSWORD_LENGTH } from "./admin.ts";
import { needsProviderKey } from "./deployment.ts";

export type ProductionAnswers = {
  vercel_token: string;
  supabase_token: string;
  // Empty: create a project in `supabase_org`, in `region`.
  project_ref?: string;
  supabase_org?: string;
  region?: string;
  db_password?: string;
  github_token?: string;
  vercel_team?: string;
  name?: string;
  agent_model: string;
  provider_key?: string;
  users: { email: string; password: string }[];
  // Start a release when done.
  release: "y";
};

type Parsed = { ok: true; value: ProductionAnswers } | { ok: false; error: string };

// The regions bootstrap.sh may ask Supabase for; Frankfurt first, next to the Vercel functions.
export const REGIONS = [
  ["eu-central-1", "Frankfurt"],
  ["eu-west-1", "Ireland"],
  ["eu-west-2", "London"],
  ["eu-west-3", "Paris"],
  ["eu-central-2", "Zurich"],
  ["eu-north-1", "Stockholm"],
  ["us-east-1", "North Virginia"],
  ["us-west-1", "North California"],
  ["ap-southeast-1", "Singapore"],
] as const;

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

// Tokens and IDs end up in shell variables and URLs. Quoting keeps them safe; these keep them sane.
const TOKEN = /^[\w.-]{8,512}$/;

export function parseProductionAnswers(input: unknown): Parsed {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const body = input as Record<string, unknown>;

  const vercel_token = text(body, "vercel_token");
  if (!TOKEN.test(vercel_token)) return { ok: false, error: "Paste the Vercel token." };
  const supabase_token = text(body, "supabase_token");
  if (!supabase_token.startsWith("sbp_") || !TOKEN.test(supabase_token)) {
    return { ok: false, error: "Paste the Supabase access token; it starts with sbp_." };
  }
  const github_token = text(body, "github_token");
  if (github_token && !github_token.startsWith("github_pat_")) {
    return { ok: false, error: "The GitHub token is a fine-grained token; it starts with github_pat_." };
  }

  const project_ref = text(body, "project_ref");
  const supabase_org = text(body, "supabase_org");
  const region = text(body, "region") || "eu-central-1";
  if (project_ref && !/^[a-z0-9]{20}$/.test(project_ref)) {
    return { ok: false, error: "A Supabase project ID is 20 lowercase letters and digits." };
  }
  if (!project_ref && !/^[\w-]{1,64}$/.test(supabase_org)) {
    return { ok: false, error: "Choose the Supabase organisation for the new project." };
  }
  if (!REGIONS.some(([code]) => code === region)) return { ok: false, error: "Unknown region." };
  // A database password may contain anything but a line break.
  const db_password = typeof body.db_password === "string" ? body.db_password : "";
  if (/[\n\r]/.test(db_password)) return { ok: false, error: "The database password must be on one line." };

  const name = text(body, "name");
  if (name && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) {
    return { ok: false, error: "Project names use lowercase letters, digits and dashes." };
  }
  const vercel_team = text(body, "vercel_team");
  if (vercel_team && !/^[\w-]{1,64}$/.test(vercel_team)) return { ok: false, error: "That is not a Vercel team slug." };

  const agent_model = text(body, "agent_model") || "scripted";
  const provider_key = text(body, "provider_key");
  if (needsProviderKey(agent_model) && !provider_key) {
    return { ok: false, error: `The model ${agent_model} needs its provider's API key.` };
  }

  const email = text(body, "email").toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter your email: it becomes the first admin." };
  if (Array.from(password).length < MIN_PASSWORD_LENGTH || /[\t\n\r]/.test(password)) {
    return { ok: false, error: `Your password needs at least ${MIN_PASSWORD_LENGTH} characters, on one line.` };
  }

  return {
    ok: true,
    value: {
      vercel_token,
      supabase_token,
      ...(project_ref ? { project_ref, ...(db_password ? { db_password } : {}) } : { supabase_org, region }),
      ...(github_token ? { github_token } : {}),
      ...(vercel_team ? { vercel_team } : {}),
      ...(name ? { name } : {}),
      agent_model,
      ...(provider_key ? { provider_key } : {}),
      users: [{ email, password }],
      release: "y",
    },
  };
}
