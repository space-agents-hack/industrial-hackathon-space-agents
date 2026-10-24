"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AddPersonForm } from "@/components/admin/add-person-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { switchOrganization } from "@/lib/org-actions";
import { sendJson } from "@/lib/send-json";

export type OrganizationSummary = {
  id: string;
  name: string;
  createdAt: string;
  activeMembers: number;
  activeAdmins: number;
  isCurrent: boolean;
};

export function OrganizationsPanel({
  organizations,
  myEmail,
}: {
  organizations: OrganizationSummary[];
  myEmail: string | null;
}) {
  const router = useRouter();
  const [switching, startSwitch] = useTransition();
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The organisation just created, and the email of its first admin if one was given; without
  // one it waits for its first admin below.
  const [created, setCreated] = useState<{ id: string; name: string; admin: string | null } | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ id: string }>("/api/admin/organizations", "POST", {
      name,
      admin_email: adminEmail,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated({ id: result.body.id, name: name.trim(), admin: adminEmail.trim().toLowerCase() || null });
    setName("");
    setAdminEmail("");
    router.refresh();
  }

  function open(id: string) {
    startSwitch(async () => {
      await switchOrganization(id);
      // People, because from the list of organisations the usual next step is who is in it.
      router.push("/admin/people");
    });
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h2 className="text-base font-semibold">All organisations</h2>
        {organizations.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-6 text-center text-muted-foreground">
            None yet. Create the first one below.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {organizations.map((org) => (
              <li key={org.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1 basis-48 truncate font-medium">
                  {org.name}
                  {org.isCurrent ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">(current)</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {org.activeMembers} active {org.activeMembers === 1 ? "person" : "people"}
                </span>
                {org.activeAdmins === 0 ? (
                  <span className="text-xs text-attention">no active admin</span>
                ) : null}
                <Button variant="outline" size="sm" disabled={switching || org.isCurrent} onClick={() => open(org.id)}>
                  Manage
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-base font-semibold">Create an organisation</h2>
        {created ? (
          <div className="grid gap-2 rounded-xl border bg-card p-4">
            {created.admin ? (
              <p>
                <strong>{created.name}</strong> exists, with <strong>{created.admin}</strong> as its admin. They
                find it in the organisation switcher, with the account and password they already have, and add
                the rest of their people themselves.
              </p>
            ) : (
              <>
                <p>
                  <strong>{created.name}</strong> exists, with nobody in it. Add its first admin; they then add
                  the rest of their people themselves. Someone who already has an account needs no password.
                </p>
                <AddPersonForm org={created.id} fixedRole="admin" submitLabel="Add admin" />
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={switching} onClick={() => open(created.id)}>
                Manage {created.name}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid min-w-0 gap-1">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label htmlFor="org-admin">First admin (optional)</Label>
              <div className="flex gap-1.5">
                <Input
                  id="org-admin"
                  type="email"
                  autoComplete="off"
                  placeholder="Email of an existing account"
                  value={adminEmail}
                  onChange={(event) => setAdminEmail(event.target.value)}
                />
                {myEmail ? (
                  <Button type="button" variant="outline" onClick={() => setAdminEmail(myEmail)}>
                    Me
                  </Button>
                ) : null}
              </div>
            </div>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create"}
            </Button>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              The first admin must already have an account; nothing is created if the email has none. Leave
              it empty to add the first admin afterwards, with a new account if they have none.
            </p>
          </form>
        )}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
