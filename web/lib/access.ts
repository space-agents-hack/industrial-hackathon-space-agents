// Who may do what, as the web shapes its pages. The database checks every action on its own
// (RLS and the `security definer` functions in supabase/migrations/20261014120000_platform.sql);
// these helpers only decide what to offer, so a button that would be refused is not shown.
// Pure, so the rules can be tested without a database.

export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const MEMBER_STATUSES = ["active", "suspended"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isMemberStatus(value: unknown): value is MemberStatus {
  return typeof value === "string" && (MEMBER_STATUSES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "manages people, settings and keys, and drafts requirements",
  member: "drafts requirements and decides approvals",
  viewer: "reads drafts, changes nothing",
};

// What `my_access()` returns, parsed. `organizations` are the ones the person is an active
// member of, with their role; `allOrganizations` is filled only for a platform admin.
export type OrganizationEntry = { id: string; name: string; role: Role | null };
export type Access = {
  platformAdmin: boolean;
  organizations: OrganizationEntry[];
  allOrganizations: { id: string; name: string }[];
};

export const NO_ACCESS: Access = { platformAdmin: false, organizations: [], allOrganizations: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

// Anything malformed is dropped rather than trusted: an entry without an id cannot be selected,
// and an unknown role grants nothing.
export function parseAccess(value: unknown): Access {
  if (!isRecord(value)) return NO_ACCESS;
  const organizations = entries(value.organizations)
    .filter((o) => typeof o.id === "string" && typeof o.name === "string")
    .map((o) => ({ id: o.id as string, name: o.name as string, role: isRole(o.role) ? o.role : null }));
  const allOrganizations = entries(value.all_organizations)
    .filter((o) => typeof o.id === "string" && typeof o.name === "string")
    .map((o) => ({ id: o.id as string, name: o.name as string }));
  return { platformAdmin: value.platform_admin === true, organizations, allOrganizations };
}

// The organisations this person can open: their own, plus every other one for a platform admin
// (with no role there unless they are also a member). Order: as the database lists them, which is
// by creation date.
export function visibleOrganizations(access: Access): OrganizationEntry[] {
  if (!access.platformAdmin) return access.organizations;
  const roles = new Map(access.organizations.map((o) => [o.id, o.role]));
  const all = access.allOrganizations.map((o) => ({ ...o, role: roles.get(o.id) ?? null }));
  // A membership the list of all organisations somehow lacks still counts.
  const missing = access.organizations.filter((o) => !all.some((a) => a.id === o.id));
  return [...all, ...missing];
}

// The cookie only says which organisation the person last chose. It is honoured only if they may
// still see it; otherwise the first visible one is used (a removed membership, a deleted org).
export function pickCurrentOrganization(
  access: Access,
  requestedId: string | undefined,
): OrganizationEntry | null {
  const visible = visibleOrganizations(access);
  return visible.find((o) => o.id === requestedId) ?? visible[0] ?? null;
}

export type Permissions = {
  read: boolean;
  startRuns: boolean;
  decideApprovals: boolean;
  manage: boolean;
};

// Mirrors the policies: runs are started and approvals decided by an active admin or member of
// the run's organisation (`has_role`), which a platform admin who is not a member is not; managing
// is `can_manage` (organisation admin or platform admin).
export function permissionsFor(role: Role | null, platformAdmin: boolean): Permissions {
  const acts = role === "admin" || role === "member";
  return {
    read: platformAdmin || role !== null,
    startRuns: acts,
    decideApprovals: acts,
    manage: platformAdmin || role === "admin",
  };
}

export function permissionsIn(access: Access, organizationId: string | null | undefined): Permissions {
  const role = access.organizations.find((o) => o.id === organizationId)?.role ?? null;
  return permissionsFor(role, access.platformAdmin);
}

// The admin area is in the nav for whoever manages the current organisation, and always for a
// platform admin (who may need it to create the first organisation).
export function showsAdmin(access: Access, current: OrganizationEntry | null): boolean {
  return access.platformAdmin || (current !== null && permissionsIn(access, current.id).manage);
}

// Someone who signed in but belongs nowhere: the app has nothing to show them.
export function hasNoAccess(access: Access): boolean {
  return !access.platformAdmin && access.organizations.length === 0;
}
