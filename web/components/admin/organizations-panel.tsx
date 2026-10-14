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

export function OrganizationsPanel({ organizations }: { organizations: OrganizationSummary[] }) {
  const router = useRouter();
  const [switching, startSwitch] = useTransition();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The organisation just created, waiting for its first admin.
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ id: string }>("/api/admin/organizations", "POST", { name });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated({ id: result.body.id, name: name.trim() });
    setName("");
    router.refresh();
  }

  function open(id: string) {
    startSwitch(async () => {
      await switchOrganization(id);
      router.push("/admin");
    });
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">All organisations</h2>
        {organizations.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
            None yet. Create the first one below.
          </p>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
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
        <h2 className="text-sm font-semibold">Create an organisation</h2>
        {created ? (
          <div className="grid gap-2 rounded-md border bg-card p-3">
            <p>
              <strong>{created.name}</strong> exists. Add its first admin; they then add the rest of
              their people themselves.
            </p>
            <AddPersonForm org={created.id} fixedRole="admin" submitLabel="Add admin" />
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid min-w-0 flex-1 basis-64 gap-1">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create"}
            </Button>
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
