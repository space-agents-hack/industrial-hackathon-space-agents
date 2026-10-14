// The form's values as a small env file the developer can open: `.env.setup.local` at the
// repository root. Pure functions here; reading and writing the file is in setup-commands.ts.

export type SavedSetup = {
  project_ref: string;
  db_password: string;
  supabase_token: string;
  vercel_token: string;
  agent_model: string;
  provider_key: string;
  releases_token: string;
  // The secret between web and agent, kept so that connecting again does not change it.
  shared_secret: string;
  users: { email: string; password: string }[];
};

export const EMPTY_SETUP: SavedSetup = {
  project_ref: "",
  db_password: "",
  supabase_token: "",
  vercel_token: "",
  agent_model: "scripted",
  provider_key: "",
  releases_token: "",
  shared_secret: "",
  users: [],
};

const FIELDS: [keyof Omit<SavedSetup, "users">, string][] = [
  ["project_ref", "SUPABASE_PROJECT_REF"],
  ["db_password", "SUPABASE_DB_PASSWORD"],
  ["supabase_token", "SUPABASE_ACCESS_TOKEN"],
  ["vercel_token", "VERCEL_TOKEN"],
  ["agent_model", "AGENT_MODEL"],
  ["provider_key", "PROVIDER_API_KEY"],
  ["releases_token", "RELEASES_GITHUB_TOKEN"],
  ["shared_secret", "AGENT_SHARED_SECRET"],
];

// Quoted only when needed, so the file stays readable; JSON quoting when it is, so any password
// survives the round trip.
function encode(value: string): string {
  return /^[A-Za-z0-9_.:@/+=,-]*$/.test(value) ? value : JSON.stringify(value);
}

function decode(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export function serializeSetup(setup: SavedSetup): string {
  const lines = [
    "# Saved by the Setup page so you do not have to type these again.",
    "# Readable only by your user account. Never committed (.gitignore: .env.*).",
    "# Delete this file, or press Forget on the Setup page, to remove them.",
    ...FIELDS.map(([key, name]) => `${name}=${encode(setup[key])}`),
  ];
  setup.users.forEach((user, index) => {
    lines.push(`USER_${index + 1}_EMAIL=${encode(user.email)}`);
    lines.push(`USER_${index + 1}_PASSWORD=${encode(user.password)}`);
  });
  return `${lines.join("\n")}\n`;
}

export function parseSetup(text: string): SavedSetup {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], decode(match[2]));
  }
  const setup: SavedSetup = { ...EMPTY_SETUP, users: [] };
  for (const [key, name] of FIELDS) {
    const value = values.get(name);
    if (value !== undefined) setup[key] = value;
  }
  if (!setup.agent_model) setup.agent_model = "scripted";
  for (let index = 1; values.has(`USER_${index}_EMAIL`); index++) {
    setup.users.push({
      email: values.get(`USER_${index}_EMAIL`) ?? "",
      password: values.get(`USER_${index}_PASSWORD`) ?? "",
    });
  }
  return setup;
}
