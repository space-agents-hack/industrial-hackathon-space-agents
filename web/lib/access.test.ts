import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Access,
  hasNoAccess,
  isReadOnly,
  parseAccess,
  permissionsFor,
  permissionsIn,
  pickCurrentOrganization,
  showsAdmin,
  visibleOrganizations,
} from "./access.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

test("each role allows what the policies allow, and no more", () => {
  assert.deepEqual(permissionsFor("admin", false), { read: true, startRuns: true, decideApprovals: true, manage: true });
  assert.deepEqual(permissionsFor("member", false), { read: true, startRuns: true, decideApprovals: true, manage: false });
  assert.deepEqual(permissionsFor("viewer", false), { read: true, startRuns: false, decideApprovals: false, manage: false });
  assert.deepEqual(permissionsFor(null, false), { read: false, startRuns: false, decideApprovals: false, manage: false });
});

test("a platform admin manages and reads every organisation but acts only where a member", () => {
  // has_role() in the insert and update policies does not include platform admins.
  assert.deepEqual(permissionsFor(null, true), { read: true, startRuns: false, decideApprovals: false, manage: true });
  assert.deepEqual(permissionsFor("member", true), { read: true, startRuns: true, decideApprovals: true, manage: true });
});

test("parseAccess reads my_access() and drops what it cannot trust", () => {
  const access = parseAccess({
    platform_admin: true,
    organizations: [
      { id: A, name: "Default", role: "admin" },
      { id: B, name: "Client", role: "owner" },
      { name: "no id", role: "admin" },
    ],
    all_organizations: [{ id: A, name: "Default" }, { id: C, name: "Other" }, "junk"],
  });
  assert.equal(access.platformAdmin, true);
  assert.deepEqual(access.organizations, [
    { id: A, name: "Default", role: "admin" },
    { id: B, name: "Client", role: null },
  ]);
  assert.deepEqual(access.allOrganizations, [
    { id: A, name: "Default" },
    { id: C, name: "Other" },
  ]);
  assert.deepEqual(parseAccess(null), { platformAdmin: false, organizations: [], allOrganizations: [] });
  // Only the literal true makes a platform admin.
  assert.equal(parseAccess({ platform_admin: "true" }).platformAdmin, false);
});

const member: Access = {
  platformAdmin: false,
  organizations: [
    { id: A, name: "Default", role: "viewer" },
    { id: B, name: "Client", role: "admin" },
  ],
  allOrganizations: [],
};

const operator: Access = {
  platformAdmin: true,
  organizations: [{ id: B, name: "Client", role: "member" }],
  allOrganizations: [
    { id: A, name: "Default" },
    { id: B, name: "Client" },
    { id: C, name: "Other" },
  ],
};

test("a member sees their organisations; a platform admin sees all, with roles where they have one", () => {
  assert.deepEqual(visibleOrganizations(member).map((o) => o.id), [A, B]);
  assert.deepEqual(visibleOrganizations(operator), [
    { id: A, name: "Default", role: null },
    { id: B, name: "Client", role: "member" },
    { id: C, name: "Other", role: null },
  ]);
});

test("the org cookie is honoured only for an organisation the person may see", () => {
  assert.equal(pickCurrentOrganization(member, B)?.id, B);
  assert.equal(pickCurrentOrganization(member, C)?.id, A, "not theirs: falls back to the first");
  assert.equal(pickCurrentOrganization(member, undefined)?.id, A);
  assert.equal(pickCurrentOrganization(operator, C)?.id, C);
  assert.equal(pickCurrentOrganization({ ...member, organizations: [] }, A), null);
});

test("the Admin link follows the role in the current organisation", () => {
  assert.equal(showsAdmin(member, { id: A, name: "Default", role: "viewer" }), false);
  assert.equal(showsAdmin(member, { id: B, name: "Client", role: "admin" }), true);
  assert.equal(showsAdmin(operator, null), true, "a platform admin may need it to create the first org");
  assert.equal(permissionsIn(member, A).startRuns, false);
  assert.equal(permissionsIn(member, B).manage, true);
  assert.equal(permissionsIn(member, C).read, false);
});

test("signed in but in no organisation means no access, unless a platform admin", () => {
  assert.equal(hasNoAccess({ platformAdmin: false, organizations: [], allOrganizations: [] }), true);
  assert.equal(hasNoAccess({ platformAdmin: true, organizations: [], allOrganizations: [] }), false);
  assert.equal(hasNoAccess(member), false);
});

test("a read-only organisation is flagged only by a literal true, for members and platform admins", () => {
  const access = parseAccess({
    platform_admin: true,
    organizations: [
      { id: A, name: "certivity", role: "viewer", read_only: true },
      { id: B, name: "Client", role: "admin", read_only: "true" },
    ],
    all_organizations: [
      { id: A, name: "certivity", read_only: true },
      { id: C, name: "Other", read_only: false },
    ],
  });
  assert.deepEqual(access.organizations[0], { id: A, name: "certivity", role: "viewer", readOnly: true });
  assert.equal(isReadOnly(access, A), true);
  assert.equal(isReadOnly(access, B), false);
  assert.equal(isReadOnly(access, C), false);
  assert.equal(visibleOrganizations(access).find((o) => o.id === A)?.readOnly, true);
  // The role the database reports is already the one in effect: a viewer starts nothing.
  assert.equal(permissionsIn({ ...access, platformAdmin: false }, A).startRuns, false);
});
