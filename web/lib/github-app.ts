// The GitHub App that gives production its own access to this one repository (ADR-0005), made
// with GitHub's manifest flow from the local Setup page: the person presses Create on GitHub,
// then Install, and nothing is copied. Pure: the manifest and the addresses. The routes are
// app/api/setup/github/*.

// What production does with it (lib/github.ts), by GitHub's "Permissions required for GitHub
// Apps" (checked 2026-10-15): read the Deploy workflow's runs and logs and start a release
// (actions); store secrets in the production environment, which needs only `environments`, not
// `secrets` (that one is for repository-level secrets); set the model (`actions_variables`, the
// manifest's name for Variables). No Administration: with it the app could delete the repository
// and create environments. No contents: it never reads or changes code.
export const APP_PERMISSIONS = {
  actions: "write",
  environments: "write",
  actions_variables: "write",
  metadata: "read",
} as const;

// GitHub app names are unique across GitHub and at most 34 characters; the random part keeps two
// clones of the same repository name from colliding.
export function appName(repoName: string, suffix: string): string {
  const base = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const tail = `-${suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6)}`;
  return `${base.slice(0, 34 - tail.length).replace(/-+$/, "")}${tail}`;
}

export type Manifest = {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: string[];
};

// `origin` is this dev server as the browser reached it: GitHub sends the browser back there.
export function appManifest(repo: string, origin: string, name: string): Manifest {
  return {
    name,
    url: `https://github.com/${repo}`,
    description: `Lets the deployed app of ${repo} show releases, start them and change its settings.`,
    // No webhooks: nothing listens for them. The documented schema requires a URL even when off.
    hook_attributes: { url: `https://github.com/${repo}`, active: false },
    redirect_url: `${origin}/api/setup/github/callback`,
    setup_url: `${origin}/api/setup/github/installed`,
    setup_on_update: true,
    // Only the account that owns it can install it.
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

// Where the browser posts the manifest: the person's settings, or the organisation's.
export function manifestAction(ownerType: string, owner: string, state: string): string {
  const base =
    ownerType === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

// The install page with the account and this repository chosen in advance, so the person only
// presses Install (`suggested_target_id` and `repository_ids[]`, documented by GitHub for this).
// `state` comes back on the setup URL, which tells the installed route the browser is ours.
export function installUrl(slug: string, ownerId: number, repoId: number, state: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new/permissions`);
  url.searchParams.set("suggested_target_id", String(ownerId));
  url.searchParams.append("repository_ids[]", String(repoId));
  url.searchParams.set("state", state);
  return url.toString();
}

// Where the owner deletes or changes the app: under the person's settings or the organisation's.
export function appSettingsUrl(ownerType: string, owner: string, slug: string): string {
  return ownerType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/${encodeURIComponent(slug)}`
    : `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
}

// The conversion's answer, reduced to what is kept. The client secret and webhook secret are
// dropped: nothing here signs users in or receives webhooks.
export type CreatedApp = { id: number; slug: string; pem: string; owner: string };

export function parseCreatedApp(body: unknown): CreatedApp | null {
  if (typeof body !== "object" || body === null) return null;
  const app = body as { id?: unknown; slug?: unknown; pem?: unknown; owner?: { login?: unknown } };
  if (typeof app.id !== "number" || typeof app.slug !== "string" || typeof app.pem !== "string") return null;
  if (!app.pem.includes("PRIVATE KEY")) return null;
  return { id: app.id, slug: app.slug, pem: app.pem, owner: typeof app.owner?.login === "string" ? app.owner.login : "" };
}
