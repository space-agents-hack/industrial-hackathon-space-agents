// What the header offers, and where a person without a project is sent (SYS-36, SYS-37). Pure, so
// the rules can be tested without a request; proxy.ts and the header both read them.

// The project the person picked. A preference like the organisation cookie, not a permission: the
// database checks every read and write on its own.
export const PROJECT_COOKIE = "project";
export const PROJECT_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 365,
} as const;

// The sections that exist only inside a project (Clemente, 2026-10-24). Their data still belongs
// to the organisation (the regulation library is the organisation's, ADR-0006); the project decides
// which part of it is shown. A run's own page is left out on purpose: a link to a run from a
// teammate should open, whatever project the reader last picked.
const PROJECT_ONLY = ["/runs", "/regulations", "/changes", "/checks"];

export function needsProject(pathname: string): boolean {
  if (/^\/runs\/[^/]+/.test(pathname)) return false;
  return PROJECT_ONLY.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export type Tab = { href: string; label: string; matches: (path: string) => boolean };

// In the order of the work: the project's cases, the runs on them, the regulations they cite, then
// the tools that act on a regulation change or on a file.
export function projectTabs(projectId: string): Tab[] {
  const home = `/projects/${projectId}`;
  return [
    { href: home, label: "Parts", matches: (path) => path === home || path.startsWith(`${home}/cases`) },
    { href: "/runs", label: "Draft requirements", matches: (path) => path === "/runs" || path.startsWith("/runs/") },
    { href: "/regulations", label: "Regulations", matches: (path) => path.startsWith("/regulations") },
    { href: "/changes", label: "Review requirements", matches: (path) => path.startsWith("/changes") },
    { href: "/checks", label: "Checks", matches: (path) => path.startsWith("/checks") },
  ];
}

// Setup and Admin in one place (SYS-37). The route stays /admin so old links and the API paths
// keep working; only the name changes.
export const SETTINGS_TAB: Tab = {
  href: "/admin",
  label: "Settings",
  matches: (path) => path.startsWith("/admin") || path.startsWith("/setup"),
};

// Settings' tabs. The organisation's for its admins; the deployment's (every organisation, the
// setup steps, releases, deployment secrets) only for platform admins: an admin of a client
// organisation must not see or change the deployment. The pages and routes refuse on their own
// (deployment_test.sql, rls_test.sql); this decides what is offered.
const ORGANIZATION_TABS = [
  { href: "/admin", label: "Models and limits" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/people", label: "People" },
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/audit", label: "Audit log" },
];
const PLATFORM_TABS = [
  { href: "/admin/organizations", label: "Organisations" },
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/releases", label: "Releases" },
  { href: "/admin/deployment", label: "Deployment" },
];

export function settingsTabs(platformAdmin: boolean): { href: string; label: string }[] {
  return platformAdmin ? [...ORGANIZATION_TABS, ...PLATFORM_TABS] : ORGANIZATION_TABS;
}
