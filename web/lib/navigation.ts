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
    { href: home, label: "Cases", matches: (path) => path === home || path.startsWith(`${home}/cases`) },
    { href: "/runs", label: "Runs", matches: (path) => path === "/runs" || path.startsWith("/runs/") },
    { href: "/regulations", label: "Regulations", matches: (path) => path.startsWith("/regulations") },
    { href: "/changes", label: "Changes", matches: (path) => path.startsWith("/changes") },
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
